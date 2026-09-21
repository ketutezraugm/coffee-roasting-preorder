CREATE TABLE batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bean_name        text NOT NULL,
  roast_level      text NOT NULL,
  quota_grams      integer NOT NULL CHECK (quota_grams > 0),
  claimed_grams    integer NOT NULL DEFAULT 0,
  price_per_kg_idr integer NOT NULL,
  closes_at        timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'Open',
  dispatched       boolean NOT NULL DEFAULT false,   -- has production received this closed batch?
  -- Last line of defence for the hard rule; the claim statement is what normally enforces it.
  CONSTRAINT claimed_within_quota CHECK (claimed_grams >= 0 AND claimed_grams <= quota_grams)
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES batches(id),
  buyer_name       text NOT NULL,
  buyer_contact    text NOT NULL,
  shipping_address text NOT NULL,
  pack_size_grams  integer NOT NULL,
  grind            text NOT NULL,
  quantity         integer NOT NULL,
  total_grams      integer NOT NULL,
  amount_idr       integer NOT NULL,   -- fixed at order time, later price changes never touch it
  status           text NOT NULL DEFAULT 'Held',
  hold_expires_at  timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_held_expiry ON orders (hold_expires_at) WHERE status = 'Held';

CREATE TABLE payments (
  payment_ref text PRIMARY KEY,   -- unique: the same payment can only be recorded once
  order_id    uuid NOT NULL REFERENCES orders(id),
  amount_idr  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
