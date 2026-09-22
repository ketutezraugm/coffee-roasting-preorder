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
  packed              boolean NOT NULL DEFAULT false,
  ready_sent          boolean NOT NULL DEFAULT false   -- has fulfilment been told this line is ready?
);
