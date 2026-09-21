CREATE TABLE production_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              text NOT NULL UNIQUE,   -- ordering's id, used only to make the create call idempotent
  bean_name             text NOT NULL,
  roast_level           text NOT NULL,
  status                text NOT NULL DEFAULT 'Queued',
  actual_sellable_grams integer
);

CREATE TABLE lines (
  seq                 bigserial PRIMARY KEY,
  production_batch_id uuid NOT NULL REFERENCES production_batches(id),
  order_id            text NOT NULL UNIQUE,
  pack_size_grams     integer NOT NULL,
  grind               text NOT NULL,
  quantity            integer NOT NULL,
  packed              boolean NOT NULL DEFAULT false
);

CREATE TABLE shipments (
  order_id          text PRIMARY KEY,
  recipient_name    text NOT NULL,
  contact           text NOT NULL,
  address           text NOT NULL,
  status            text NOT NULL DEFAULT 'AwaitingPacking',
  tracking_number   text,
  ordering_notified boolean NOT NULL DEFAULT false
);
