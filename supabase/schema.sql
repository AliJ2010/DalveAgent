-- DALVE cloud sync schema. Run this once in the Supabase project's SQL Editor
-- (Project → SQL Editor → New query → paste → Run).
--
-- Auth (signup/login/sessions) is handled entirely by Supabase's built-in `auth.users` table —
-- nothing custom to build there. Row Level Security below means a signed-in user can only ever
-- see their OWN rows, enforced by Postgres itself, not by application code that could have bugs.
--
-- Gemini/Composio API keys ARE stored here (plaintext column, protected the same way as every
-- other row: RLS below means only the owning signed-in user can ever read their own row, plus
-- Supabase's at-rest encryption and TLS in transit) so a key entered on one device shows up on
-- every other device signed into the same account. Still NOT stored: current screen/mouse/window
-- state, local file paths, OS permissions — those stay device-local on purpose.

create table if not exists public.agents (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('companion', 'bot')),
  parent_id text,
  color text not null,
  system_prompt text not null default '',
  tool_scope jsonb not null default '[]',
  memory text not null default '',
  voice text not null default 'Kore',
  status text not null default 'idle',
  archived boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null
);

create table if not exists public.settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  composio_connections jsonb not null default '[]',
  composio_auth_config_ids jsonb not null default '{}',
  mcp_servers jsonb not null default '[]',
  dalve_voice text not null default 'Kore',
  dalve_memory text not null default '',
  gemini_api_key text,
  composio_api_key text,
  updated_at bigint not null default (extract(epoch from now()) * 1000)
);

-- If you already ran this file once before these two columns existed, run this too:
-- alter table public.settings add column if not exists gemini_api_key text;
-- alter table public.settings add column if not exists composio_api_key text;

create table if not exists public.journal_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  date text not null, -- YYYY-MM-DD
  lines jsonb not null default '[]',
  updated_at bigint not null default (extract(epoch from now()) * 1000),
  primary key (user_id, date)
);

alter table public.agents enable row level security;
alter table public.settings enable row level security;
alter table public.journal_entries enable row level security;

create policy "own agents only" on public.agents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own settings only" on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own journal only" on public.journal_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Enables live push updates (Mac changes something -> Windows sees it within moments).
alter publication supabase_realtime add table public.agents;
alter publication supabase_realtime add table public.settings;
alter publication supabase_realtime add table public.journal_entries;
