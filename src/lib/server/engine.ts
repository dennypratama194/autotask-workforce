import type {
  AgentKind, Attachment, InputRequest, Message, Priority, Project, Result, Run, RunKind, Snapshot, Task,
  TaskDetail, TaskSource, TaskStatus, Worker,
} from "@/lib/domain/types";
import {
  ACTIVE_RUN_STATES, CHANGES_ERROR, CHANGES_MIN, checkMove, checkPrereqs, deriveNextOwner, isExecuting,
  taskRef, validateAnswer,
} from "@/lib/domain/rules";
import { hashToken, newToken, UserError, type Ctx } from "./db";

type Res<T> = { data: T; error: { message: string; code?: string } | null };
export async function q<T>(p: PromiseLike<unknown>): Promise<T> {
  const { data, error } = (await p) as Res<T>;
  if (error) throw new Error(error.message);
  return data;
}

export const now = () => new Date().toISOString();

// ---- reads ----

export async function getTask(c: Ctx, id: string) {
  const t = await q<Task | null>(c.db.from("tasks").select("*").eq("id", id).maybeSingle());
  if (!t) throw new UserError("Task not found.");
  return t;
}
export async function getTaskByNumber(c: Ctx, n: number) {
  const t = await q<Task | null>(c.db.from("tasks").select("*").eq("number", n).maybeSingle());
  if (!t) throw new UserError(`${taskRef(n)} does not exist.`);
  return t;
}
export const getProject = (c: Ctx, id: string) => q<Project>(c.db.from("projects").select("*").eq("id", id).single());
export const taskRuns = (c: Ctx, taskId: string) =>
  q<Run[]>(c.db.from("runs").select("*").eq("task_id", taskId).order("attempt", { ascending: false }));
export async function activeRun(c: Ctx, taskId: string) {
  const r = await q<Run[]>(c.db.from("runs").select("*").eq("task_id", taskId).in("state", ACTIVE_RUN_STATES).limit(1));
  return r[0] ?? null;
}
async function hasResult(c: Ctx, taskId: string) {
  const runs = await taskRuns(c, taskId);
  if (!runs.length) return false;
  const res = await q<{ id: string }[]>(c.db.from("results").select("id").in("run_id", runs.map((r) => r.id)).limit(1));
  return res.length > 0;
}

const stripWorker = (w: Worker & { token_hash?: unknown; owner_id?: unknown }): Worker => {
  const { token_hash: _t, owner_id: _o, ...rest } = w;
  return rest;
};

export async function snapshot(c: Ctx): Promise<Snapshot> {
  await sweep(c);
  const [projects, tasks, runs, requests, notifications, activity, workers, ints, settings, checks, results] = await Promise.all([
    q<Project[]>(c.db.from("projects").select("*").order("name")),
    q<Task[]>(c.db.from("tasks").select("*").order("sort_order")),
    q<Run[]>(c.db.from("runs").select("*").order("attempt", { ascending: false })),
    q<InputRequest[]>(c.db.from("input_requests").select("*").eq("state", "open").order("created_at")),
    q<Snapshot["notifications"]>(c.db.from("notifications").select("*").order("created_at", { ascending: false }).limit(50)),
    q<Snapshot["activity"]>(c.db.from("activity").select("*").order("at", { ascending: false }).limit(50)),
    q<(Worker & { token_hash?: string })[]>(c.db.from("workers").select("*").order("created_at")),
    q<{ id: string; key: string; state: Snapshot["integrations"][number]["state"]; last_success_at: string | null; token_hash: string | null }[]>(
      c.db.from("integrations").select("*"),
    ),
    q<Snapshot["settings"]>(c.db.from("settings").select("*").maybeSingle()),
    q<Snapshot["checks"]>(c.db.from("checks").select("*")),
    q<{ run_id: string }[]>(c.db.from("results").select("run_id")),
  ]);
  return {
    projects, tasks, runs, requests, notifications, activity, checks, settings,
    resultRunIds: results.map((r) => r.run_id),
    workers: workers.map(stripWorker),
    integrations: ints.map((i) => ({ id: i.id, key: i.key, state: i.state, last_success_at: i.last_success_at, has_token: !!i.token_hash })),
  };
}

export async function taskDetail(c: Ctx, number: number): Promise<TaskDetail> {
  const task = await getTaskByNumber(c, number);
  const [project, criteria, messages, requests, runs, activity, attachments, workers] = await Promise.all([
    getProject(c, task.project_id),
    q<TaskDetail["criteria"]>(c.db.from("acceptance_criteria").select("*").eq("task_id", task.id).order("position")),
    q<TaskDetail["messages"]>(c.db.from("messages").select("*").eq("task_id", task.id).order("created_at")),
    q<TaskDetail["requests"]>(c.db.from("input_requests").select("*").eq("task_id", task.id).order("created_at")),
    taskRuns(c, task.id),
    q<TaskDetail["activity"]>(c.db.from("activity").select("*").eq("task_id", task.id).order("at", { ascending: false })),
    q<Attachment[]>(c.db.from("attachments").select("*").eq("task_id", task.id)),
    q<Worker[]>(c.db.from("workers").select("*")),
  ]);
  const ids = runs.map((r) => r.id);
  const inRuns = async <T,>(table: string, order: string) =>
    ids.length ? q<T[]>(c.db.from(table).select("*").in("run_id", ids).order(order)) : ([] as T[]);
  const [events, checks, results, artifacts] = await Promise.all([
    inRuns<TaskDetail["events"][number]>("run_events", "at"),
    inRuns<TaskDetail["checks"][number]>("checks", "created_at"),
    inRuns<Result>("results", "created_at"),
    inRuns<TaskDetail["artifacts"][number]>("artifacts", "position"),
  ]);
  const clean = workers.map(stripWorker);
  await q(c.db.from("tasks").update({ last_viewed_at: now() }).eq("id", task.id));
  return {
    task, project, criteria, messages, requests, runs, events, checks, results, artifacts, activity, attachments,
    workers: clean, worker: clean.find((w) => w.id === project.worker_id) ?? null,
  };
}

// ---- shared writes ----

export async function log(c: Ctx, taskId: string, action: string, text: string, runId?: string | null) {
  await q(c.db.from("activity").insert({ owner_id: c.ownerId, task_id: taskId, run_id: runId ?? null, actor: c.actor, action, text, at: now() }));
}

/** Writes a task patch and keeps next_owner in step with PRD 6.3. */
export async function setTask(c: Ctx, id: string, patch: Partial<Task>) {
  const t = await getTask(c, id);
  const status = patch.status ?? t.status;
  const override = status === "in_progress" ? (patch.owner_override !== undefined ? patch.owner_override : t.owner_override) : null;
  const running = await q<Run[]>(c.db.from("runs").select("id").eq("task_id", id).eq("state", "running").limit(1));
  await q(c.db.from("tasks").update({ ...patch, owner_override: override, next_owner: deriveNextOwner(status, running.length > 0, override) }).eq("id", id));
}

export async function notify(c: Ctx, taskId: string, kind: "input_requested" | "result_ready" | "failure_needs_action", text: string, ids: { request_id?: string; run_id?: string } = {}) {
  const group_key = `${taskId}:${kind}`;
  const unread = await q<{ id: string }[]>(c.db.from("notifications").select("id").eq("group_key", group_key).is("read_at", null).limit(1));
  const row = { text, request_id: ids.request_id ?? null, run_id: ids.run_id ?? null };
  if (unread[0]) await q(c.db.from("notifications").update(row).eq("id", unread[0].id));
  else await q(c.db.from("notifications").insert({ ...row, owner_id: c.ownerId, task_id: taskId, kind, group_key }));
}

export async function nextAttempt(c: Ctx, taskId: string) {
  const runs = await taskRuns(c, taskId);
  return (runs[0]?.attempt ?? 0) + 1;
}

const noWorkers = async (c: Ctx) => (await q<{ id: string }[]>(c.db.from("workers").select("id").limit(1))).length === 0;

export async function prereqsFor(c: Ctx, task: Task, project: Project) {
  const active = await activeRun(c, task.id);
  return checkPrereqs({
    repo: project.repo,
    agent: task.agent ?? project.default_agent,
    workerId: project.worker_id,
    brief: task.brief,
    activeRunAttempt: active?.attempt ?? null,
  });
}

/** Creates a queued run with its snapshot. Caller has verified prerequisites. */
export async function createQueuedRun(c: Ctx, task: Task, project: Project, kind: RunKind) {
  const [criteria, msgs] = await Promise.all([
    q<TaskDetail["criteria"]>(c.db.from("acceptance_criteria").select("*").eq("task_id", task.id).order("position")),
    q<Message[]>(c.db.from("messages").select("*").eq("task_id", task.id).in("kind", ["instruction", "answer"]).order("created_at")),
  ]);
  const attempt = await nextAttempt(c, task.id);
  const run = await q<Run>(
    c.db.from("runs").insert({
      owner_id: c.ownerId, task_id: task.id, attempt, kind, agent: "claude_code", worker_id: project.worker_id, state: "queued",
      brief_snapshot: task.brief, criteria_snapshot: criteria.map((x) => ({ position: x.position, text: x.text })),
      instructions_snapshot: msgs.map((m) => ({ kind: m.kind, body: m.body, at: m.created_at })),
      branch: `ai/tw-${task.number}`, queued_at: now(),
    }).select("*").single(),
  );
  await setTask(c, task.id, { status: "ai_queue", agent: "claude_code", sort_order: Date.now(), brief_changed_during_run: false });
  await log(c, task.id, "run_queued", `Queued run ${attempt} (${kind})`, run.id);
  return run;
}

// ---- tasks ----

export type NewTask = {
  project_id: string; title: string; brief: string; criteria: string[]; reference_url?: string | null; priority?: Priority;
  due_date?: string | null; source?: TaskSource; agent?: AgentKind | null; run_with_ai?: boolean;
};

export async function createTask(c: Ctx, i: NewTask) {
  const project = await getProject(c, i.project_id);
  const agent = i.agent ?? project.default_agent;
  const task = await q<Task>(
    c.db.from("tasks").insert({
      owner_id: c.ownerId, project_id: i.project_id, title: i.title.trim(), brief: i.brief, reference_url: i.reference_url ?? null,
      priority: i.priority ?? "normal", due_date: i.due_date ?? null, source: i.source ?? "platform", agent, sort_order: Date.now(),
      status: "inbox", next_owner: "none",
    }).select("*").single(),
  );
  if (i.criteria.length) {
    await q(c.db.from("acceptance_criteria").insert(i.criteria.map((text, position) => ({ owner_id: c.ownerId, task_id: task.id, position, text }))));
  }
  await log(c, task.id, "task_created", `Created ${taskRef(task.number)}`);
  if (i.run_with_ai) {
    const blocked = await prereqsFor(c, task, project);
    if (blocked.length) return { task, blocked };
    await createQueuedRun(c, task, project, "initial");
  }
  return { task, blocked: [] as string[] };
}

export type MoveResult = { message?: string };

/** PRD 6.1 */
export async function moveTask(c: Ctx, id: string, to: TaskStatus, sortOrder?: number): Promise<MoveResult> {
  const task = await getTask(c, id);
  const active = await activeRun(c, id);
  const check = checkMove({ from: task.status, activeRun: active?.state ?? null, hasResult: await hasResult(c, id) }, to);
  if (!check.ok) throw new UserError(check.message);
  const sort_order = sortOrder ?? Date.now();

  if (to === "ai_queue") {
    const project = await getProject(c, task.project_id);
    if (await noWorkers(c)) {
      await setTask(c, id, { status: to, sort_order });
      await log(c, id, "moved", "Moved to AI Queue");
      return { message: "No worker yet · tracking only" };
    }
    const blocked = await prereqsFor(c, task, project);
    if (blocked.length) throw new UserError("This task can't be queued yet.", blocked);
    await createQueuedRun(c, task, project, "initial");
    return {};
  }
  if (to === "inbox" && active) {
    await q(c.db.from("runs").update({ state: "cancelled", ended_at: now(), end_note: "Removed from the queue" }).eq("id", active.id));
    await q(c.db.from("input_requests").update({ state: "withdrawn" }).eq("task_id", id).eq("state", "open"));
    await log(c, id, "run_cancelled", "Removed from the queue", active.id);
  }
  const patch: Partial<Task> = { status: to, sort_order };
  const approved = to === "done" && task.status === "review";
  if (approved) patch.accepted_at = now();
  await setTask(c, id, patch);
  await log(c, id, to === "done" && !approved ? "marked_done" : "moved",
    to === "done" ? (approved ? "Approved completion" : "Marked Done manually") : `Moved to ${to.replace("_", " ")}`);
  return to === "in_progress" ? { message: "Moved to In Progress. This doesn't start an agent." } : {};
}

export async function reorderTask(c: Ctx, id: string, sort_order: number) {
  await q(c.db.from("tasks").update({ sort_order }).eq("id", id));
}

export type TaskPatch = Partial<Pick<Task, "title" | "brief" | "priority" | "due_date" | "agent" | "project_id" | "owner_override">>;

export async function updateTask(c: Ctx, id: string, patch: TaskPatch) {
  const task = await getTask(c, id);
  const active = await activeRun(c, id);
  if (patch.project_id && patch.project_id !== task.project_id && active) throw new UserError("Stop the run before changing the project.");
  if (patch.agent === "codex") throw new UserError("Codex can't execute work yet; its adapter is planned for a later stage.");
  if (patch.owner_override !== undefined && task.status !== "in_progress") throw new UserError("Next owner can only be changed while the task is In Progress.");
  if (patch.title !== undefined && !patch.title.trim()) throw new UserError("A task needs a title.");
  const extra: Partial<Task> = {};
  if (patch.brief !== undefined && patch.brief !== task.brief) {
    if (active) extra.brief_changed_during_run = true;
    await log(c, id, "brief_edited", active ? `Brief edited after run ${active.attempt} started` : "Brief edited", active?.id);
  }
  await setTask(c, id, { ...patch, ...extra });
}

export async function archiveTask(c: Ctx, id: string, archived: boolean) {
  const active = await activeRun(c, id);
  if (active && isExecuting(active.state)) throw new UserError("Stop the run before archiving.");
  await q(c.db.from("tasks").update({ archived_at: archived ? now() : null }).eq("id", id));
  await log(c, id, archived ? "archived" : "unarchived", archived ? "Archived" : "Restored from archive");
}

export async function cancelTask(c: Ctx, id: string) {
  const active = await activeRun(c, id);
  if (active && isExecuting(active.state)) throw new UserError("Stop the run before cancelling.");
  if (active) {
    await q(c.db.from("runs").update({ state: "cancelled", ended_at: now(), end_note: "Task cancelled" }).eq("id", active.id));
    await q(c.db.from("input_requests").update({ state: "withdrawn" }).eq("task_id", id).eq("state", "open"));
  }
  await q(c.db.from("tasks").update({ cancelled_at: now() }).eq("id", id));
  await log(c, id, "cancelled", "Cancelled the task");
}

export async function addCriterion(c: Ctx, taskId: string, text: string) {
  const existing = await q<TaskDetail["criteria"]>(c.db.from("acceptance_criteria").select("*").eq("task_id", taskId));
  await q(c.db.from("acceptance_criteria").insert({ owner_id: c.ownerId, task_id: taskId, text, position: existing.length }));
}
export async function acceptCriterion(c: Ctx, id: string, accepted: boolean) {
  await q(c.db.from("acceptance_criteria").update({ accepted, accepted_at: accepted ? now() : null }).eq("id", id));
}

// ---- conversation ----

export type AttachmentInput = { storage_path: string; file_name: string; size_bytes: number; mime: string | null };

async function saveAttachments(c: Ctx, taskId: string, list: AttachmentInput[] | undefined, ids: { message_id?: string; request_id?: string }) {
  if (!list?.length) return;
  await q(c.db.from("attachments").insert(list.map((a) => ({ ...a, ...ids, owner_id: c.ownerId, task_id: taskId, state: "ready" }))));
}

export type SendResult = { message: string; blocked?: string[] };

/** PRD 7.2 */
export async function sendMessage(
  c: Ctx,
  i: { task_id: string; mode: "comment" | "instruction"; body: string; client_id: string; attachments?: AttachmentInput[] },
): Promise<SendResult> {
  const dup = await q<Message | null>(c.db.from("messages").select("*").eq("client_id", i.client_id).maybeSingle());
  if (dup) return { message: "Already sent." };
  const body = i.body.trim();
  if (!body && !i.attachments?.length) throw new UserError("Write a message first.");
  const task = await getTask(c, i.task_id);
  const active = await activeRun(c, task.id);

  if (i.mode === "comment") {
    const m = await q<Message>(c.db.from("messages").insert({ owner_id: c.ownerId, task_id: task.id, author: "denny", kind: "comment", body, client_id: i.client_id }).select("*").single());
    await saveAttachments(c, task.id, i.attachments, { message_id: m.id });
    return { message: "Comment added." };
  }
  const m = await q<Message>(c.db.from("messages").insert({
    owner_id: c.ownerId, task_id: task.id, author: "denny", kind: "instruction", body, client_id: i.client_id, pending_for_next_run: true,
  }).select("*").single());
  await saveAttachments(c, task.id, i.attachments, { message_id: m.id });
  if (active) return { message: "Pending: saved for the next run. The running agent hasn't received it." };
  const project = await getProject(c, task.project_id);
  const blocked = await prereqsFor(c, task, project);
  if (blocked.length) return { message: "Instruction saved. It will be included in the next run.", blocked };
  await createQueuedRun(c, task, project, "instruction");
  return { message: "Instruction saved and run queued." };
}

export type AnswerPayload = {
  request_id: string; choice?: number | null; text?: string | null; confirmed?: boolean; note?: string | null;
  attachments?: AttachmentInput[];
};

/** PRD 7.3 */
export async function answerRequest(c: Ctx, a: AnswerPayload): Promise<{ message: string }> {
  const req = await q<InputRequest | null>(c.db.from("input_requests").select("*").eq("id", a.request_id).maybeSingle());
  if (!req) throw new UserError("That request no longer exists.");
  if (req.state !== "open") return { message: "This request was already resolved." };
  const err = validateAnswer(req.kind, req.choices.length, { ...a, hasFile: !!a.attachments?.length });
  if (err) throw new UserError(err);

  const choiceText = a.choice !== null && a.choice !== undefined ? req.choices[a.choice] : null;
  const answerBody = [choiceText, a.text?.trim(), req.kind === "action" ? "Done." : null, a.note?.trim()].filter(Boolean).join("\n");
  await q(c.db.from("input_requests").update({
    state: "resolved", answer_text: [a.text?.trim(), a.note?.trim()].filter(Boolean).join("\n") || null,
    answer_choice: a.choice ?? null, answered_at: now(),
  }).eq("id", req.id));
  const msg = await q<Message>(c.db.from("messages").insert({ owner_id: c.ownerId, task_id: req.task_id, author: "denny", kind: "answer", body: answerBody || "Answered.", run_id: req.run_id }).select("*").single());
  await saveAttachments(c, req.task_id, a.attachments, { message_id: msg.id, request_id: req.id });
  await q(c.db.from("notifications").update({ read_at: now() }).eq("request_id", req.id).is("read_at", null));
  await log(c, req.task_id, "request_answered", `Answered: ${req.question}`, req.run_id);

  const others = await q<InputRequest[]>(c.db.from("input_requests").select("*").eq("task_id", req.task_id).eq("state", "open").eq("required", true));
  if (others.length) {
    const n = others.length;
    return { message: `Answer saved. ${n} more request${n > 1 ? "s" : ""} still block${n > 1 ? "" : "s"} this task: ${others[0]!.question}` };
  }

  const run = req.run_id ? await q<Run | null>(c.db.from("runs").select("*").eq("id", req.run_id).maybeSingle()) : null;
  const waitingRun = run?.state === "waiting_for_input" ? run : null;

  if (a.choice !== null && a.choice !== undefined && a.choice === req.manual_choice_index) {
    if (waitingRun) await q(c.db.from("runs").update({ state: "completed", ended_at: now(), end_note: "Denny took over manually." }).eq("id", waitingRun.id));
    await setTask(c, req.task_id, { status: "in_progress", owner_override: "denny" });
    return { message: "Answer saved. You own this task now; no run was started." };
  }
  if (waitingRun && !waitingRun.worker_id) {
    // Phase 1: the reporting session reads the answer through get_answer.
    await q(c.db.from("runs").update({ state: "running", last_heartbeat_at: now() }).eq("id", waitingRun.id));
    await setTask(c, req.task_id, { status: "in_progress", owner_override: null });
    return { message: "Answer saved. The session reads it on its next check." };
  }
  if (run?.worker_id) {
    if (waitingRun) await q(c.db.from("runs").update({
      state: "completed", ended_at: now(), end_note: "Ended at an input request. Work continues in the next run with your answer.",
    }).eq("id", waitingRun.id));
    const task = await getTask(c, req.task_id);
    const project = await getProject(c, task.project_id);
    const blocked = await prereqsFor(c, task, project);
    if (blocked.length) {
      await setTask(c, req.task_id, { status: "in_progress", owner_override: null });
      return { message: `Answer saved. No run was queued: ${blocked[0]}` };
    }
    await createQueuedRun(c, task, project, "continuation");
    const worker = project.worker_id ? await q<Worker | null>(c.db.from("workers").select("*").eq("id", project.worker_id).maybeSingle()) : null;
    return { message: worker?.state === "offline" ? "Answer saved. Work will resume when the worker is online." : "Answer saved. A continuation run is queued." };
  }
  await setTask(c, req.task_id, { status: "in_progress", owner_override: null });
  return { message: "Answer saved." };
}

// ---- review ----

export async function approve(c: Ctx, id: string) {
  const task = await getTask(c, id);
  if (task.status !== "review") throw new UserError("Only a task in Review can be approved.");
  if (await activeRun(c, id)) throw new UserError("A run is active on this task.");
  await setTask(c, id, { status: "done", accepted_at: now() });
  await log(c, id, "approved", "Approved completion");
}

/** PRD 7.4. Without a worker the instruction waits for the reporting session (get_task). */
export async function requestChanges(c: Ctx, id: string, text: string, client_id: string): Promise<{ message: string }> {
  if (text.trim().length < CHANGES_MIN) throw new UserError(CHANGES_ERROR);
  const dup = await q<Message | null>(c.db.from("messages").select("*").eq("client_id", client_id).maybeSingle());
  if (dup) return { message: "Already sent." };
  const task = await getTask(c, id);
  if (task.status !== "review") throw new UserError("Only a task in Review can get change requests.");
  await q(c.db.from("messages").insert({
    owner_id: c.ownerId, task_id: id, author: "denny", kind: "instruction", body: text.trim(), client_id, pending_for_next_run: true,
  }));
  await log(c, id, "changes_requested", "Requested changes");
  const project = await getProject(c, task.project_id);
  const blocked = await prereqsFor(c, task, project);
  if (blocked.length) {
    await setTask(c, id, { status: "in_progress", owner_override: "ai" });
    return { message: "Changes saved. No worker can run them, so the reporting session receives them through get_task." };
  }
  await createQueuedRun(c, task, project, "changes");
  return { message: "Changes saved and run queued." };
}

// ---- runs ----

/** PRD 7.6 */
export async function stopRun(c: Ctx, taskId: string): Promise<{ message: string }> {
  const run = await activeRun(c, taskId);
  if (!run) throw new UserError("No run is active.");
  if (run.state === "queued" || !run.worker_id) {
    const queued = run.state === "queued";
    await q(c.db.from("runs").update({
      state: "cancelled", ended_at: now(),
      end_note: queued ? "Removed from the queue" : "Marked stopped here. The external session itself isn't controlled by this app.",
    }).eq("id", run.id));
    await q(c.db.from("input_requests").update({ state: "withdrawn" }).eq("task_id", taskId).eq("state", "open"));
    await setTask(c, taskId, { status: queued ? "inbox" : "in_progress", owner_override: null });
    await log(c, taskId, "run_stopped", `Stopped run ${run.attempt}`, run.id);
    return { message: queued ? "Removed from the queue." : "Marked stopped. The external session isn't controlled by this app." };
  }
  await q(c.db.from("runs").update({ state: "stopping", stop_requested_at: now() }).eq("id", run.id));
  await log(c, taskId, "stop_requested", "Stop requested", run.id);
  return { message: "Stop requested. Waiting for the worker to confirm. Stop doesn't revert files." };
}

export async function queueNewRun(c: Ctx, taskId: string, kind: "retry" | "initial"): Promise<{ message: string }> {
  const task = await getTask(c, taskId);
  const project = await getProject(c, task.project_id);
  const blocked = await prereqsFor(c, task, project);
  if (blocked.length) throw new UserError("This task can't be queued yet.", blocked);
  await createQueuedRun(c, task, project, kind);
  return { message: kind === "retry" ? "Retry queued as a new run." : "Run queued." };
}

export async function takeOver(c: Ctx, taskId: string) {
  await setTask(c, taskId, { status: "in_progress", owner_override: "denny" });
  await log(c, taskId, "took_over", "Denny took over");
}

/** PRD 9.2: expire leases. Also keeps worker state honest when a worker dies silently. */
export async function sweep(c: Ctx) {
  const stamp = now();
  const expired = await q<Run[]>(c.db.from("runs").select("*").in("state", ["running", "pausing", "paused", "stopping"]).lt("lease_expires_at", stamp));
  for (const run of expired) {
    if (!run.worker_id) continue;
    const w = await q<Worker | null>(c.db.from("workers").select("*").eq("id", run.worker_id).maybeSingle());
    const mins = Math.max(1, Math.round((Date.now() - new Date(run.last_heartbeat_at ?? stamp).getTime()) / 60000));
    await q(c.db.from("runs").update({
      state: "interrupted", ended_at: stamp,
      end_note: `No heartbeat from ${w?.name ?? "the worker"} for ${mins} minutes during ${run.step_label ?? "Reading project"}. Some files may be partly edited on branch ${run.branch}.`,
    }).eq("id", run.id));
    await setTask(c, run.task_id, { status: "in_progress" });
    await log({ ...c, actor: "System" }, run.task_id, "run_interrupted", `Run ${run.attempt} stalled`, run.id);
  }
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  await q(c.db.from("workers").update({ state: "offline" }).in("state", ["online", "busy"]).lt("last_seen_at", cutoff));
}

// ---- projects, settings, tokens ----

export type ProjectInput = Partial<Pick<Project,
  "name" | "purpose" | "context" | "repo" | "base_branch" | "preview_url" | "worker_id" | "default_agent" |
  "verification_commands" | "retry_limit" | "time_limit_minutes" | "pinned" | "archived">>;

export async function createProject(c: Ctx, i: { name: string; purpose?: string; context?: string; repo?: string | null }) {
  const base = i.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const taken = await q<{ slug: string }[]>(c.db.from("projects").select("slug"));
  let slug = base;
  for (let n = 2; taken.some((t) => t.slug === slug); n++) slug = `${base}-${n}`;
  return q<Project>(c.db.from("projects").insert({
    owner_id: c.ownerId, slug, name: i.name.trim(), purpose: i.purpose ?? "", context: i.context ?? "", repo: i.repo || null,
    base_branch: i.repo ? "main" : null, default_agent: i.repo ? "claude_code" : null,
  }).select("*").single());
}

export async function updateProject(c: Ctx, id: string, patch: ProjectInput) {
  if (patch.default_agent === "codex") throw new UserError("Codex can't execute work yet.");
  await q(c.db.from("projects").update(patch).eq("id", id));
}

export async function markRead(c: Ctx, id: string | "all") {
  const u = c.db.from("notifications").update({ read_at: now() });
  await q(id === "all" ? u.is("read_at", null) : u.eq("id", id));
}

export async function updateSettings(c: Ctx, patch: { timezone?: string; setup_step?: number; setup_completed?: boolean }) {
  await q(c.db.from("settings").upsert({
    owner_id: c.ownerId,
    ...(patch.timezone ? { timezone: patch.timezone } : {}),
    ...(patch.setup_step !== undefined ? { setup_step: patch.setup_step } : {}),
    ...(patch.setup_completed ? { setup_completed_at: now() } : {}),
  }, { onConflict: "owner_id" }));
}

export async function issueIntegrationToken(c: Ctx, key: "claude_code_mcp" | "codex_mcp") {
  const token = newToken("twr");
  await q(c.db.from("integrations").upsert({ owner_id: c.ownerId, key, state: "connected", token_hash: hashToken(token) }, { onConflict: "key" }));
  return token;
}
export async function revokeIntegrationToken(c: Ctx, key: string) {
  await q(c.db.from("integrations").update({ state: "not_configured", token_hash: null }).eq("key", key));
}
export async function registerWorker(c: Ctx, i: { name: string; machine_label: string }) {
  const token = newToken("twk");
  const w = await q<{ id: string }>(c.db.from("workers").insert({ owner_id: c.ownerId, name: i.name, machine_label: i.machine_label, state: "needs_setup", token_hash: hashToken(token), supported_agents: [] }).select("id").single());
  return { id: w.id, token };
}
export async function revokeWorker(c: Ctx, id: string) {
  await q(c.db.from("projects").update({ worker_id: null }).eq("worker_id", id));
  await q(c.db.from("workers").delete().eq("id", id));
}
