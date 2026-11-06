-- Additions needed by M1-M6. See docs/DECISIONS.md.

alter table tasks add column reference_url text;
alter table workers add column held_until timestamptz;
alter table workers add column hold_reason text;

-- Idempotency ledger: replaying an event_id returns the stored result.
create table mcp_events (
  event_id text primary key,
  owner_id uuid not null references auth.users(id),
  tool text not null,
  result jsonb,
  created_at timestamptz not null default now()
);
alter table mcp_events enable row level security;
create policy mcp_events_owner_only on mcp_events for all to authenticated
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

alter publication supabase_realtime add table tasks, messages, input_requests, runs, notifications;

insert into storage.buckets (id, name, public) values ('attachments', 'attachments', false)
  on conflict (id) do nothing;
create policy attachments_owner_only on storage.objects for all to authenticated
  using (bucket_id = 'attachments' and owner = auth.uid())
  with check (bucket_id = 'attachments');

-- PRD 9.2: oldest queued run whose project has no executing run.
create or replace function claim_run(p_worker uuid, p_lease_seconds int default 90)
returns setof runs
language plpgsql security definer set search_path = public as $$
declare
  w workers;
  r runs;
begin
  perform pg_advisory_xact_lock(hashtext(p_worker::text));
  select * into w from workers where id = p_worker;
  if not found or (w.held_until is not null and w.held_until > now()) then
    return;
  end if;
  if (select count(*) from runs
      where worker_id = p_worker and state in ('running','pausing','paused','stopping')) >= w.max_concurrent_runs then
    return;
  end if;
  select q.* into r
  from runs q
  join tasks t on t.id = q.task_id
  where q.state = 'queued' and q.worker_id = p_worker
    and not exists (
      select 1 from runs x join tasks tx on tx.id = x.task_id
      where tx.project_id = t.project_id and x.state in ('running','pausing','paused','stopping')
    )
  order by q.queued_at
  limit 1
  for update of q skip locked;
  if not found then
    return;
  end if;
  update runs set
    state = 'running',
    claimed_at = now(),
    started_at = now(),
    last_heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    external_session_id = id::text
  where id = r.id
  returning * into r;
  return next r;
end $$;

revoke all on function claim_run(uuid, int) from public, anon, authenticated;
grant execute on function claim_run(uuid, int) to service_role;
