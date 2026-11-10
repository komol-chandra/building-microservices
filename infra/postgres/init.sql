-- Runs ONCE, the first time the postgres volume is created.
-- Database-per-service: each service gets its own database AND its own user.
-- A service's user can only reach its own database, so no service can
-- "just join" another service's tables.

CREATE USER product_svc   WITH PASSWORD 'product_pw';
CREATE USER inventory_svc WITH PASSWORD 'inventory_pw';
CREATE USER order_svc     WITH PASSWORD 'order_pw';

CREATE DATABASE product_db   OWNER product_svc;
CREATE DATABASE inventory_db OWNER inventory_svc;
CREATE DATABASE order_db     OWNER order_svc;

-- Stop everyone (PUBLIC) from connecting to databases that aren't theirs.
REVOKE CONNECT ON DATABASE product_db   FROM PUBLIC;
REVOKE CONNECT ON DATABASE inventory_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE order_db     FROM PUBLIC;
GRANT  CONNECT ON DATABASE product_db   TO product_svc;
GRANT  CONNECT ON DATABASE inventory_db TO inventory_svc;
GRANT  CONNECT ON DATABASE order_db     TO order_svc;

-- Prisma "migrate dev" needs to create a temporary shadow database.
ALTER USER product_svc   CREATEDB;
ALTER USER inventory_svc CREATEDB;
ALTER USER order_svc     CREATEDB;
