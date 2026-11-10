import type { ServerResponse } from 'node:http';
import type { Express, Request, RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import config from './config.json';
import { authorize, type Role } from './auth';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface RouteRule {
  method: Method;
  path: string;
  service: string;
  roles: Role[];
}

/** service name → base URL, read from env (env var names come from config.json). */
export function serviceUrls(): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [name, envVar] of Object.entries(config.services)) {
    const url = process.env[envVar];
    if (!url) throw new Error(`Missing env ${envVar} (service "${name}")`);
    urls[name] = url;
  }
  return urls;
}

function makeProxy(service: string, target: string): RequestHandler {
  return createProxyMiddleware<Request, Response>({
    target,
    changeOrigin: true,
    proxyTimeout: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 5000), // upstream must answer within this
    on: {
      // Upstream down / unreachable / too slow → clean JSON instead of a hung or HTML error.
      error: (err, req, res) => {
        const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        const timedOut = code === 'ECONNRESET' || code === 'ETIMEDOUT';
        console.error(`[gateway] ${req.method} ${req.url} → ${service} failed: ${code}`);
        const r = res as ServerResponse;
        if (!r.headersSent) r.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' });
        r.end(
          JSON.stringify({
            error: timedOut ? 'GatewayTimeout' : 'BadGateway',
            message: `${service}-service is unavailable`,
            code,
          }),
        );
      },
    },
  });
}

/** Turns config.json into Express routes: auth check → proxy to the owning service. */
export function registerRoutes(app: Express): void {
  const urls = serviceUrls();
  const proxies = new Map(Object.entries(urls).map(([name, url]) => [name, makeProxy(name, url)]));

  for (const rule of config.routes as RouteRule[]) {
    const proxy = proxies.get(rule.service);
    if (!proxy) throw new Error(`config.json: unknown service "${rule.service}"`);
    const method = rule.method.toLowerCase() as Lowercase<Method>;
    app[method](rule.path, authorize(rule.roles), proxy);
    const access = rule.roles.length ? rule.roles.join('|') : 'public';
    console.log(`[gateway] ${rule.method.padEnd(4)} ${rule.path.padEnd(32)} → ${rule.service} (${access})`);
  }
}
