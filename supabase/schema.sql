-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).

create table if not exists public.cases (
  case_id             text primary key,
  raw_label           text not null,
  case_tier           text not null default 'unknown'
                       check (case_tier in ('fyi', 'guest_contact', 'second_escalation', 'unknown')),
  complaint_category  text,
  store_pc            text,
  customer_name       text,
  customer_complaint  text,
  date_in_sent        date,
  amount              numeric(10, 2),
  email               text,
  phone               text,
  comments            text,
  severity_score      int not null default 0,
  severity_label      text not null default 'low'
                       check (severity_label in ('low', 'medium', 'high')),
  sheet_tab           text not null,
  last_synced_at      timestamptz not null default now()
);

create index if not exists idx_cases_store_pc  on public.cases (store_pc);
create index if not exists idx_cases_severity  on public.cases (severity_score desc);
create index if not exists idx_cases_sheet_tab on public.cases (sheet_tab);

-- Simple log so the dashboard can show "last synced" and you can spot failures.
create table if not exists public.sync_runs (
  id            bigint generated always as identity primary key,
  run_type      text not null check (run_type in ('current_month', 'historical')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  rows_synced   int,
  tabs_synced   text[],
  error         text
);

create index if not exists idx_sync_runs_started on public.sync_runs (started_at desc);

-- Row Level Security: the dashboard reads with the public "anon" key, so it
-- only ever gets SELECT access. All writes happen from the sync functions
-- using the service role key, which bypasses RLS entirely.
alter table public.cases enable row level security;
alter table public.sync_runs enable row level security;

create policy "public read access to cases"
  on public.cases for select
  using (true);

create policy "public read access to sync_runs"
  on public.sync_runs for select
  using (true);
