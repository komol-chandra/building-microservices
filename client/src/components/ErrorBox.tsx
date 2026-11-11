export default function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error">{error}</div> : null;
}
