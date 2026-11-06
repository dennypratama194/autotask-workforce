-- Task Workspace schema (PRD section 5, RLS per section 12)

create type task_status   as enum ('inbox','ai_queue','in_progress','needs_denny','review','done');
create type next_owner    as enum ('denny','ai','none');
create type priority      as enum ('low','normal','high','urgent');
create type agent_kind    as enum ('claude_code','codex');
create type task_source   as enum ('platform','claude_code_vscode','claude_code_cli','codex_cli','chatgpt');
create type message_kind  as enum ('comment','instruction','answer','update','question','result','system');
create type author_kind   as enum ('denny','agent','system');
create type request_kind  as enum ('choice','text','asset','action');
create type request_state as enum ('open','resolved','withdrawn');
create type request_reason as enum ('decision_required','waiting_for_asset','authentication_required','access_required','retry_limit_reached','usage_limit_reached','other');
create type run_state     as enum ('queued','running','waiting_for_input','pausing','paused','stopping','completed','failed','cancelled','interrupted');
create type run_kind      as enum ('initial','continuation','changes','retry','instruction','external');
create type check_state   as enum ('passed','failed','not_run','unknown');
create type artifact_kind as enum ('preview','screenshot','pr','commit','document','change_summary');
create type worker_state  as enum ('online','busy','offline','needs_setup','auth_required');
create type integration_state as enum ('not_configured','connected','needs_auth','error','unavailable');

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create sequence task_number_seq start 1;

-- workers first: projects reference it
create table workers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  machine_label text,
  state worker_state not null default 'needs_setup',
  supported_agents agent_kind[] not null default '{}',
  last_seen_at timestamptz,
  token_hash text,
  max_concurrent_runs int not null default 2
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  slug text not null unique,
  name text not null,
  purpose text not null default '',
  context text not null default '',
  repo text,
  base_branch text,
  preview_url text,
  reference_links text[] not null default '{}',
  worker_id uuid references workers(id) on delete set null,
  default_agent agent_kind,
  verification_commands text[] not null default '{}',
  retry_limit int not null default 1 check (retry_limit between 0 and 2),
  time_limit_minutes int not null default 30,
  pinned boolean not null default false,
  archived boolean not null default false
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  number int not null unique default nextval('task_number_seq'),
  project_id uuid not null references projects(id),
  title text not null,
  brief text not null default '',
  status task_status not null default 'inbox',
  next_owner next_owner not null default 'none',
  owner_override next_owner,
  agent agent_kind,
  priority priority not null default 'normal',
  due_date date,
  source task_source not null default 'platform',
  sort_order double precision not null default 0,
  archived_at timestamptz,
  cancelled_at timestamptz,
  accepted_at timestamptz,
  brief_changed_during_run boolean not null default false,
  last_viewed_at timestamptz
);

create table acceptance_criteria (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id uuid not null references tasks(id) on delete cascade,
  position int not null default 0,
  text text not null,
  agent_state check_state not null default 'unknown',
  agent_run_id uuid,
  accepted boolean not null default false,
  accepted_at timestamptz
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id uuid not null references tasks(id) on delete cascade,
  attempt int not null,
  kind run_kind not null,
  agent agent_kind not null,
  worker_id uuid references workers(id) on delete set null,
  external_session_id text,
  state run_state not null default 'queued',
  step int not null default 0 check (step between 0 and 3),
  step_label text,
  note text,
  brief_snapshot text,
  criteria_snapshot jsonb,
  instructions_snapshot jsonb,
  branch text,
  worktree_path text,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  last_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  error_summary text,
  last_meaningful_step text,
  partial_output text,
  suggested_action text,
  end_note text,
  wait_reason text,
  usage jsonb,
  stop_requested_at timestamptz,
  pause_requested_at timestamptz,
  unique (task_id, attempt)
);

create unique index runs_one_active_per_task on runs (task_id)
  where state in ('queued','running','waiting_for_input','pausing','paused','stopping');

create table messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id uuid not null references tasks(id) on delete cascade,
  author author_kind not null,
  agent agent_kind,
  kind message_kind not null,
  body text not null default '',
  run_id uuid references runs(id) on delete set null,
  pending_for_next_run boolean not null default false,
  delivered_run_id uuid references runs(id) on delete set null,
  client_id text unique,
  external_event_id text unique
);

create table input_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id uuid not null references tasks(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  kind request_kind not null,
  reason request_reason not null default 'decision_required',
  question text not null,
  context text not null default '',
  blocks text not null default '',
  choices text[] not null default '{}',
  manual_choice_index int,
  required boolean not null default true,
  state request_state not null default 'open',
  answer_text text,
  answer_choice int,
  answered_at timestamptz,
  asked_by text not null default 'Claude Code',
  external_event_id text unique
);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id uuid not null references tasks(id) on delete cascade,
  message_id uuid references messages(id) on delete cascade,
  request_id uuid references input_requests(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  size_bytes bigint not null default 0,
  mime text,
  state text not null default 'uploading' check (state in ('uploading','ready','error'))
);

create table run_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  run_id uuid not null references runs(id) on delete cascade,
  at timestamptz not null default now(),
  level text not null default 'info',
  text text not null,
  external_event_id text unique
);

create table checks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  run_id uuid not null references runs(id) on delete cascade,
  name text not null,
  state check_state not null default 'unknown',
  source text not null default 'agent' check (source in ('agent','owner')),
  detail text
);

create table results (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  run_id uuid not null unique references runs(id) on delete cascade,
  summary text not null,
  changes text[] not null default '{}',
  limitations text[] not null default '{}'
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  run_id uuid not null references runs(id) on delete cascade,
  kind artifact_kind not null,
  label text not null,
  url text,
  storage_path text,
  issue text,
  position int not null default 0
);

create table activity (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id uuid not null references tasks(id) on delete cascade,
  run_id uuid references runs(id) on delete set null,
  actor text not null,
  action text not null,
  text text not null,
  at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id uuid not null references tasks(id) on delete cascade,
  request_id uuid references input_requests(id) on delete set null,
  run_id uuid references runs(id) on delete set null,
  kind text not null check (kind in ('input_requested','result_ready','failure_needs_action')),
  text text not null,
  read_at timestamptz,
  group_key text not null
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  key text not null unique,
  state integration_state not null default 'not_configured',
  last_success_at timestamptz,
  token_hash text
);

create table settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  timezone text not null default 'device',
  setup_completed_at timestamptz,
  setup_step int not null default 0
);

-- Indexes
create index tasks_status_sort_idx on tasks (status, sort_order);
create index tasks_project_idx on tasks (project_id);
create index runs_task_attempt_idx on runs (task_id, attempt);
create index runs_state_idx on runs (state);
create index input_requests_open_idx on input_requests (task_id) where state = 'open';

-- updated_at trigger and owner-only RLS on every table
do $$
declare t text;
begin
  foreach t in array array[
    'workers','projects','tasks','acceptance_criteria','runs','messages','input_requests',
    'attachments','run_events','checks','results','artifacts','activity','notifications',
    'integrations','settings'
  ] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_updated_at', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id)', t || '_owner_only', t);
  end loop;
end $$;
