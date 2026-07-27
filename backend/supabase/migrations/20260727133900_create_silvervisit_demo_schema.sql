create table if not exists public.sandbox_fixtures (
  seed integer primary key,
  fixture jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.navigator_sessions (
  id uuid primary key,
  user_goal text not null,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.sandbox_runs (
  id uuid primary key,
  seed integer not null references public.sandbox_fixtures(seed),
  source text not null,
  navigator_session_id uuid references public.navigator_sessions(id),
  fixture jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sandbox_run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.sandbox_runs(id) on delete cascade,
  step text not null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.plan_action_events (
  id bigint generated always as identity primary key,
  session_id uuid references public.navigator_sessions(id) on delete set null,
  turn_id text,
  request_summary jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_navigator_sessions_created_at on public.navigator_sessions(created_at);
create index if not exists idx_navigator_sessions_expires_at on public.navigator_sessions(expires_at);
create index if not exists idx_sandbox_runs_created_at on public.sandbox_runs(created_at);
create index if not exists idx_sandbox_run_events_run_id_created_at on public.sandbox_run_events(run_id, created_at);
create index if not exists idx_plan_action_events_session_id_created_at on public.plan_action_events(session_id, created_at);

alter table public.sandbox_fixtures enable row level security;
alter table public.navigator_sessions enable row level security;
alter table public.sandbox_runs enable row level security;
alter table public.sandbox_run_events enable row level security;
alter table public.plan_action_events enable row level security;
