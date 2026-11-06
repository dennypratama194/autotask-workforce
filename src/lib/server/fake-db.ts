import { randomUUID } from "node:crypto";

/**
 * In-memory stand-in for the subset of supabase-js the engine uses.
 * Only for unit tests and the Playwright suite. It is never reachable in production (see db.ts).
 */
type Row = Record<string, unknown>;
type Err = { message: string; code?: string } | null;

const UNIQUE: Record<string, string[]> = {
  mcp_events: ["event_id"],
  messages: ["client_id", "external_event_id"],
  tasks: ["number"],
  projects: ["slug"],
  integrations: ["key"],
  results: ["run_id"],
};

const DEFAULTS: Record<string, () => Row> = {
  tasks: () => ({
    brief: "", status: "inbox", next_owner: "none", owner_override: null, agent: null, priority: "normal", due_date: null,
    source: "platform", sort_order: 0, archived_at: null, cancelled_at: null, accepted_at: null,
    brief_changed_during_run: false, last_viewed_at: null, reference_url: null,
  }),
  projects: () => ({
    purpose: "", context: "", repo: null, base_branch: null, preview_url: null, reference_links: [], worker_id: null,
    default_agent: null, verification_commands: [], retry_limit: 1, time_limit_minutes: 30, pinned: false, archived: false,
  }),
  runs: () => ({
    worker_id: null, external_session_id: null, state: "queued", step: 0, step_label: null, note: null, branch: null,
    worktree_path: null, queued_at: new Date().toISOString(), claimed_at: null, started_at: null, ended_at: null,
    last_heartbeat_at: null, lease_expires_at: null, error_summary: null, last_meaningful_step: null, partial_output: null,
    suggested_action: null, end_note: null, wait_reason: null, usage: null, stop_requested_at: null, pause_requested_at: null,
  }),
  messages: () => ({ agent: null, run_id: null, pending_for_next_run: false, delivered_run_id: null, client_id: null, external_event_id: null }),
  input_requests: () => ({
    run_id: null, reason: "decision_required", context: "", blocks: "", choices: [], manual_choice_index: null, required: true,
    state: "open", answer_text: null, answer_choice: null, answered_at: null, asked_by: "Claude Code",
  }),
  acceptance_criteria: () => ({ position: 0, agent_state: "unknown", agent_run_id: null, accepted: false, accepted_at: null }),
  notifications: () => ({ request_id: null, run_id: null, read_at: null }),
  activity: () => ({ run_id: null, at: new Date().toISOString() }),
  run_events: () => ({ at: new Date().toISOString(), level: "info", external_event_id: null }),
  workers: () => ({ machine_label: null, state: "needs_setup", supported_agents: [], last_seen_at: null, token_hash: null, max_concurrent_runs: 2, held_until: null, hold_reason: null }),
  integrations: () => ({ state: "not_configured", last_success_at: null, token_hash: null }),
  settings: () => ({ timezone: "device", setup_completed_at: null, setup_step: 0 }),
  checks: () => ({ source: "agent", detail: null }),
  artifacts: () => ({ url: null, storage_path: null, issue: null, position: 0 }),
};

class Query implements PromiseLike<{ data: unknown; error: Err }> {
  private filters: ((r: Row) => boolean)[] = [];
  private sorts: { col: string; asc: boolean }[] = [];
  private max: number | null = null;
  private mode: "one" | "maybe" | null = null;
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private onConflict: string | null = null;

  constructor(private store: FakeDb, private table: string) {}

  select(_cols?: string) { return this; }
  insert(v: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row | Row[], o?: { onConflict?: string }) { this.op = "upsert"; this.payload = Array.isArray(v) ? v : [v]; this.onConflict = o?.onConflict ?? null; return this; }
  update(v: Row) { this.op = "update"; this.patch = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  is(c: string, _v: null) { this.filters.push((r) => r[c] === null || r[c] === undefined); return this; }
  lt(c: string, v: string) { this.filters.push((r) => r[c] != null && String(r[c]) < v); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.sorts.push({ col, asc: o?.ascending ?? true }); return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  single() { this.mode = "one"; return this; }
  then<A, B>(ok?: ((v: { data: unknown; error: Err }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }

  private run(): { data: unknown; error: Err } {
    const rows = (this.store.tables[this.table] ??= []);
    let out: Row[] = [];
    if (this.op === "insert" || this.op === "upsert") {
      for (const p of this.payload) {
        const existing = this.onConflict ? rows.find((r) => r[this.onConflict!] === p[this.onConflict!]) : undefined;
        if (existing) { Object.assign(existing, p); out.push(existing); continue; }
        for (const u of UNIQUE[this.table] ?? []) {
          if (p[u] != null && rows.some((r) => r[u] === p[u]))
            return { data: null, error: { message: "duplicate key", code: "23505" } };
        }
        const stamp = new Date().toISOString();
        const row: Row = { id: randomUUID(), created_at: stamp, updated_at: stamp, ...(DEFAULTS[this.table]?.() ?? {}), ...p };
        if (this.table === "tasks" && row.number === undefined) row.number = ++this.store.taskSeq;
        rows.push(row);
        out.push(row);
      }
    } else {
      const matched = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === "update") {
        matched.forEach((r) => Object.assign(r, this.patch, { updated_at: new Date().toISOString() }));
        out = matched;
      } else if (this.op === "delete") {
        this.store.tables[this.table] = rows.filter((r) => !matched.includes(r));
        out = matched;
      } else {
        out = [...matched];
        for (const s of [...this.sorts].reverse()) {
          out.sort((a, b) => {
            const x = a[s.col] as string | number; const y = b[s.col] as string | number;
            return (x < y ? -1 : x > y ? 1 : 0) * (s.asc ? 1 : -1);
          });
        }
        if (this.max !== null) out = out.slice(0, this.max);
      }
    }
    const copies = out.map((r) => ({ ...r }));
    if (this.mode) {
      if (!copies.length && this.mode === "one") return { data: null, error: { message: "no rows" } };
      return { data: copies[0] ?? null, error: null };
    }
    return { data: copies, error: null };
  }
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  taskSeq = 0;
  from(table: string) {
    return new Query(this, table);
  }
  async rpc(name: string, args: { p_worker: string }) {
    if (name !== "claim_run") return { data: null, error: { message: "unknown rpc" } };
    const runs = this.tables.runs ?? [];
    const tasks = this.tables.tasks ?? [];
    const exec = ["running", "pausing", "paused", "stopping"];
    const projectOf = (r: Row) => tasks.find((t) => t.id === r.task_id)?.project_id;
    const worker = (this.tables.workers ?? []).find((w) => w.id === args.p_worker);
    if (!worker) return { data: [], error: null };
    if (worker.held_until && String(worker.held_until) > new Date().toISOString()) return { data: [], error: null };
    if (runs.filter((r) => r.worker_id === args.p_worker && exec.includes(r.state as string)).length >= (worker.max_concurrent_runs as number))
      return { data: [], error: null };
    const next = runs
      .filter((r) => r.state === "queued" && r.worker_id === args.p_worker)
      .filter((r) => !runs.some((x) => exec.includes(x.state as string) && projectOf(x) === projectOf(r)))
      .sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at)))[0];
    if (!next) return { data: [], error: null };
    const stamp = new Date();
    Object.assign(next, {
      state: "running", claimed_at: stamp.toISOString(), started_at: stamp.toISOString(), last_heartbeat_at: stamp.toISOString(),
      lease_expires_at: new Date(stamp.getTime() + 90_000).toISOString(), external_session_id: next.id,
    });
    return { data: [{ ...next }], error: null };
  }
}
