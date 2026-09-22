CREATE TABLE shipments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          text NOT NULL UNIQUE,   -- ordering's id, used to make creation idempotent
  recipient_name    text NOT NULL,
  contact           text NOT NULL,
  address           text NOT NULL,
  status            text NOT NULL DEFAULT 'AwaitingPacking',
  tracking_number   text,
  ordering_notified boolean NOT NULL DEFAULT false
);
