-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- The /webhook/gumroad and /api/verify-purchase endpoints fail with
-- "Could not find the table 'public.gumroad_purchases'" until it exists,
-- which means Gumroad sales are not recorded and subscribers can never
-- verify their purchase to unlock Trending.

create table if not exists public.gumroad_purchases (
  id uuid primary key default gen_random_uuid(),
  sale_id text unique not null,
  email text not null,
  product_permalink text,
  refunded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists gumroad_purchases_email_idx
  on public.gumroad_purchases (email);

-- No policies: only the backend's secret (service) key can read/write.
alter table public.gumroad_purchases enable row level security;
