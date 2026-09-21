ALTER TABLE production_batches ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
