import type { AgentKind, Check, NextOwner, Priority, RequestReason, Run, RunState, Snapshot, Task, TaskSource, TaskStatus } from "./domain/types";
import { ACTIVE_RUN_STATES, taskRef } from "./domain/rules";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  inbox: "Inbox", ai_queue: "AI Queue", in_progress: "In Progress", needs_denny: "Needs Denny", review: "Review", done: "Done",
};
export const OWNER_LABEL: Record<NextOwner, string> = { denny: "Denny", ai: "AI", none: "None" };
export const AGENT_LABEL: Record<AgentKind, string> = { claude_code: "Claude Code", codex: "Codex" };
export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
export const SOURCE_LABEL: Record<TaskSource, string> = {
  platform: "Task Workspace", claude_code_vscode: "Claude Code (VS Code)", claude_code_cli: "Claude Code (CLI)", codex_cli: "Codex CLI", chatgpt: "ChatGPT",
};
export const RUN_LABEL: Record<RunState, string> = {
  queued: "Queued", running: "Running", waiting_for_input: "Waiting for input", pausing: "Pausing", paused: "Paused", stopping: "Stopping",
  completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted",
};
export const REASON_LABEL: Record<RequestReason, string> = {
  decision_required: "Decision required", waiting_for_asset: "Waiting for asset", authentication_required: "Authentication required",
  access_required: "Access required", retry_limit_reached: "Retry limit reached", usage_limit_reached: "Usage limit reached", other: "Needs input",
};
export const STEP_LABELS = ["Reading project", "Editing files", "Running checks", "Preparing result"];

export const latestRun = (s: Pick<Snapshot, "runs">, taskId: string): Run | undefined => s.runs.find((r) => r.task_id === taskId);
export const activeRunOf = (s: Pick<Snapshot, "runs">, taskId: string) =>
  s.runs.find((r) => r.task_id === taskId && ACTIVE_RUN_STATES.includes(r.state));

export function ago(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "never";
  const m = Math.round((nowMs - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60 ? `${m % 60}m ` : ""}ago`;
  return `${Math.floor(h / 24)}d ago`;
}
export const ageShort = (iso: string) => ago(iso).replace(" ago", "");

export function checkSummary(checks: Pick<Check, "state">[]): string | null {
  if (!checks.length) return null;
  const n = (s: Check["state"]) => checks.filter((c) => c.state === s).length;
  const parts = [
    n("failed") && `${n("failed")} failed`, n("passed") && `${n("passed")} passed`,
    n("not_run") && `${n("not_run")} not run`, n("unknown") && `${n("unknown")} unknown`,
  ].filter(Boolean);
  return `Checks: ${parts.join(", ")}`;
}

/** PRD 6.5: a concrete reason a queued run hasn't started. */
export function queueReason(s: Snapshot, run: Run): string {
  const worker = s.workers.find((w) => w.id === run.worker_id);
  if (!worker) return "No worker assigned";
  if (worker.held_until && new Date(worker.held_until) > new Date()) return worker.hold_reason ?? "Usage limit reached · resets later";
  if (worker.state === "offline" || worker.state === "needs_setup") return `Worker offline · last seen ${ago(worker.last_seen_at)}`;
  if (worker.state === "auth_required") return "Authentication required";
  const task = s.tasks.find((t) => t.id === run.task_id);
  const blocker = s.runs.find((r) => {
    if (!["running", "pausing", "paused", "stopping"].includes(r.state)) return false;
    return s.tasks.find((t) => t.id === r.task_id)?.project_id === task?.project_id;
  });
  if (blocker) {
    const t = s.tasks.find((x) => x.id === blocker.task_id);
    return `Project busy · queued behind ${t ? taskRef(t.number) : "another task"}`;
  }
  return `Waiting for ${worker.name}`;
}

/** PRD 10.2 secondary state priority. */
export function secondaryLine(s: Snapshot, t: Task): string {
  const r = latestRun(s, t.id);
  if (r) {
    if (r.state === "queued") return queueReason(s, r);
    if (r.state === "running") return `${r.step_label ?? STEP_LABELS[r.step]} (step ${r.step + 1} of 4)`;
    if (r.state === "stopping") return "Stop requested";
    if (r.state === "waiting_for_input") return "Waiting for your answer";
    if (r.state === "interrupted") return r.wait_reason ?? `Agent stalled · last heartbeat ${ago(r.last_heartbeat_at)}`;
    if (r.state === "failed" && t.status === "needs_denny") return "Failed · retry limit reached";
    if (t.status === "review") {
      const summary = checkSummary(s.checks.filter((c) => c.run_id === r.id));
      if (summary) return summary;
    }
  }
  if (t.accepted_at) return `Accepted ${ago(t.accepted_at)}`;
  if (t.status === "ai_queue") return "No worker yet · tracking only";
  return r ? RUN_LABEL[r.state] : "Manual task";
}

export type Filters = {
  q: string; project: string; owner: string; agent: string; priority: string; status: string; archived: boolean;
};
export const EMPTY_FILTERS: Filters = { q: "", project: "", owner: "", agent: "", priority: "", status: "", archived: false };
export const filtersActive = (f: Filters) => Object.entries(f).some(([k, v]) => v !== EMPTY_FILTERS[k as keyof Filters]);

export function applyFilters(tasks: Task[], f: Filters, projectName: (id: string) => string): Task[] {
  const needle = f.q.trim().toLowerCase();
  return tasks.filter((t) => {
    if (!f.archived && (t.archived_at || t.cancelled_at)) return false;
    if (f.project && t.project_id !== f.project) return false;
    if (f.owner && t.next_owner !== f.owner) return false;
    if (f.agent === "manual" ? t.agent !== null : f.agent && t.agent !== f.agent) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.status && t.status !== f.status) return false;
    if (needle) {
      const hay = `${taskRef(t.number)} ${t.title} ${t.brief} ${projectName(t.project_id)}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export type NeedsItem = {
  task: Task; heading: string; reason: string; blocks: string; since: string; count: number; kind: "answer" | "stalled" | "review";
};

/** PRD 10.5, ordered by priority, then due date, then oldest waiting. */
export function needsItems(s: Snapshot): { answer: NeedsItem[]; review: NeedsItem[] } {
  const live = s.tasks.filter((t) => !t.archived_at && !t.cancelled_at);
  const answer: NeedsItem[] = [];
  const review: NeedsItem[] = [];
  for (const t of live) {
    const open = s.requests.filter((r) => r.task_id === t.id);
    const run = latestRun(s, t.id);
    if (open[0]) {
      answer.push({ task: t, heading: open[0].question, reason: REASON_LABEL[open[0].reason], blocks: open[0].blocks, since: open[0].created_at, count: open.length, kind: "answer" });
    } else if (run?.state === "interrupted" && t.status === "in_progress" && t.next_owner !== "ai" && !t.owner_override) {
      const usage = run.wait_reason?.startsWith("Usage limit");
      answer.push({ task: t, heading: run.end_note ?? "The agent stopped reporting.", reason: usage ? "Usage limit reached" : "Agent stalled", blocks: t.title, since: run.ended_at ?? run.created_at, count: 1, kind: "stalled" });
    }
    if (t.status === "review") {
      review.push({ task: t, heading: t.title, reason: "Result ready", blocks: "", since: run?.ended_at ?? t.updated_at, count: 1, kind: "review" });
    }
  }
  const order = (a: NeedsItem, b: NeedsItem) =>
    PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority] ||
    (a.task.due_date ?? "9999").localeCompare(b.task.due_date ?? "9999") ||
    a.since.localeCompare(b.since);
  return { answer: answer.sort(order), review: review.sort(order) };
}

export const isNew = (t: Task) => !t.last_viewed_at && t.source !== "platform";
export function hasNewResult(s: Snapshot, t: Task) {
  if (t.status !== "review") return false;
  const r = latestRun(s, t.id);
  return !!r?.ended_at && (!t.last_viewed_at || r.ended_at > t.last_viewed_at);
}
