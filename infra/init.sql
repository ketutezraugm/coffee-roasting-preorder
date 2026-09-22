-- Run once as a Postgres superuser:  psql -U postgres -f infra/init.sql
-- Dev-only passwords. Change them outside a local machine.
-- Each role can connect to its own database only (B2).

CREATE ROLE ordering_user    LOGIN PASSWORD 'ordering_pw';
CREATE ROLE production_user  LOGIN PASSWORD 'production_pw';
CREATE ROLE fulfilment_user  LOGIN PASSWORD 'fulfilment_pw';

CREATE DATABASE ordering_db    OWNER ordering_user;
CREATE DATABASE production_db  OWNER production_user;
CREATE DATABASE fulfilment_db  OWNER fulfilment_user;

-- New databases are connectable by PUBLIC by default; the owner keeps access.
REVOKE CONNECT ON DATABASE ordering_db    FROM PUBLIC;
REVOKE CONNECT ON DATABASE production_db  FROM PUBLIC;
REVOKE CONNECT ON DATABASE fulfilment_db  FROM PUBLIC;
