import { z } from "zod";
import type { InputRequest, Message, Run, Task } from "@/lib/domain/types";
import { parseTaskRef, redact, retriesLeft, taskRef } from "@/lib/domain/rules";
import { UserError, type Ctx } from "./db";
import {
  activeRun, createQueuedRun, createTask, getProject, getTaskByNumber, log, nextAttempt, notify, now, q, setTask, taskRuns,
} from "./engine";

const check = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "_") : v),
  z.enum(["passed", "failed", "not_run", "unknown"]),
);
const eventId = z.string().min(8).max(200);
const agent = z.enum(["claude_code", "codex"]);
const source = z.enum(["platform", "claude_code_vscode", "claude_code_cli", "codex_cli", "chatgpt"]);

export const schemas = {
  list_projects: z.object({}),
  create_task: z.object({ project_slug: z.string(), title: z.string().min(1), brief: z.string().default(""), criteria: z.array(z.string()).default([]), source: source.default("claude_code_cli"), event_id: eventId }),
  link_session: z.object({ task_id: z.string(), session_id: z.string().min(1), agent: agent.default("claude_code"), source: source.optional(), event_id: eventId }),
  post_update: z.object({ task_id: z.string(), session_id: z.string(), text: z.string().min(1), step: z.number().int().min(0).max(3).optional(), event_id: eventId }),
  ask_denny: z.object({
    task_id: z.string(), session_id: z.string(), question: z.string().min(1), context: z.string().default(""), blocks: z.string().default(""),
    kind: z.enum(["choice", "text", "asset", "action"]).default("text"), choices: z.array(z.string()).default([]),
    reason: z.enum(["decision_required", "waiting_for_asset", "authentication_required", "access_required", "retry_limit_reached", "usage_limit_reached", "other"]).default("decision_required"),
    event_id: eventId,
  }),
  get_answer: z.object({ request_id: z.string() }),
  get_task: z.object({ task_id: z.string(), since: z.string().optional() }),
  submit_result: z.object({
    task_id: z.string(), session_id: z.string(), summary: z.string().min(1), changes: z.array(z.string()).default([]), limitations: z.array(z.string()).default([]),
    checks: z.array(z.object({ name: z.string(), state: check })).default([]),
    artifacts: z.array(z.object({ kind: z.enum(["preview", "screenshot", "pr", "commit", "document", "change_summary"]), label: z.string(), url: z.string().optional() })).default([]),
    criteria_states: z.array(check).default([]), event_id: eventId,
  }),
  report_failure: z.object({ task_id: z.string(), session_id: z.string(), error_summary: z.string().min(1), last_step: z.string().default(""), partial_output: z.string().default(""), suggested_action: z.string().default(""), event_id: eventId }),
} as const;

export type ToolName = keyof typeof schemas;

const DESCRIPTIONS: Record<ToolName, string> = {
  list_projects: "List projects: slug, name, repo.",
  create_task: "Create a task once. Ask Denny before calling this. Returns the TW-N id.",
  link_session: "Link this session to a task at the start of work. Moves the task to In Progress.",
  post_update: "Post a short progress update when moving between reading, editing, checking and preparing the result.",
  ask_denny: "Ask Denny for a decision, asset, access or manual action. Then poll get_answer; do not guess.",
  get_answer: "Read the state of a request made with ask_denny. Returns at once; poll it.",
  get_task: "Read the brief, criteria, open requests, messages and pending instructions. Marks pending instructions delivered.",
  submit_result: "Submit the finished result. Never report a check as passed unless you ran it. Moves the task to Review.",
  report_failure: "Report that work failed and needs Denny.",
};

async function resolveTask(c: Ctx, ref: string): Promise<Task> {
  const n = parseTaskRef(ref);
  if (n === null) throw new UserError(`"${ref}" is not a task id. Use the form TW-142.`);
  return getTaskByNumber(c, n);
}

async function sessionRun(c: Ctx, task: Task, session: string): Promise<Run> {
  const r = await q<Run[]>(c.db.from("runs").select("*").eq("task_id", task.id).eq("external_session_id", session).order("attempt", { ascending: false }).limit(1));
  if (!r[0]) throw new UserError(`Session is not linked to ${taskRef(task.number)}. Call link_session first.`);
  return r[0];
}

/** PRD 6.2: an older run never overwrites status set by a newer run. */
async function isLatest(c: Ctx, run: Run) {
  const runs = await taskRuns(c, run.task_id);
  return runs[0]?.id === run.id;
}

async function event(c: Ctx, runId: string, text: string, level = "info") {
  await q(c.db.from("run_events").insert({ owner_id: c.ownerId, run_id: runId, text: redact(text), level, at: now() }));
}

const handlers: { [K in ToolName]: (c: Ctx, i: z.infer<(typeof schemas)[K]>) => Promise<unknown> } = {
  async list_projects(c) {
    return q(c.db.from("projects").select("slug, name, repo").eq("archived", false));
  },

  async create_task(c, i) {
    const p = await q<{ id: string } | null>(c.db.from("projects").select("id").eq("slug", i.project_slug).maybeSingle());
    if (!p) throw new UserError(`No project with slug "${i.project_slug}". Call list_projects.`);
    const { task } = await createTask(c, { project_id: p.id, title: i.title, brief: i.brief, criteria: i.criteria, source: i.source });
    return { task_id: taskRef(task.number) };
  },

  async link_session(c, i) {
    const task = await resolveTask(c, i.task_id);
    const existing = await q<Run[]>(c.db.from("runs").select("*").eq("task_id", task.id).eq("external_session_id", i.session_id).in("state", ["running", "waiting_for_input"]).limit(1));
    if (existing[0]) return { run_id: existing[0].id, attempt: existing[0].attempt, reused: true };
    const other = await activeRun(c, task.id);
    if (other) throw new UserError(`Run ${other.attempt} is already active on this task.`);
    const run = await q<Run>(c.db.from("runs").insert({
      owner_id: c.ownerId, task_id: task.id, attempt: await nextAttempt(c, task.id), kind: "external", agent: i.agent, external_session_id: i.session_id,
      state: "running", started_at: now(), last_heartbeat_at: now(), step_label: "Reading project",
    }).select("*").single());
    await setTask(c, task.id, { status: "in_progress", agent: i.agent, owner_override: null, ...(i.source ? { source: i.source } : {}) });
    await log(c, task.id, "session_linked", `Session linked as run ${run.attempt}`, run.id);
    return { run_id: run.id, attempt: run.attempt, reused: false };
  },

  async post_update(c, i) {
    const task = await resolveTask(c, i.task_id);
    const run = await sessionRun(c, task, i.session_id);
    const text = redact(i.text);
    await event(c, run.id, text);
    if (!(await isLatest(c, run))) return { stored: "log_only" };
    const LABELS = ["Reading project", "Editing files", "Running checks", "Preparing result"];
    await q(c.db.from("messages").insert({ owner_id: c.ownerId, task_id: task.id, author: "agent", agent: run.agent, kind: "update", body: text, run_id: run.id }));
    await q(c.db.from("runs").update({
      note: text, last_heartbeat_at: now(), last_meaningful_step: text,
      ...(i.step !== undefined ? { step: i.step, step_label: LABELS[i.step] } : {}),
    }).eq("id", run.id));
    return { stored: "update" };
  },

  async ask_denny(c, i) {
    const task = await resolveTask(c, i.task_id);
    const run = await sessionRun(c, task, i.session_id);
    if (i.kind === "choice" && i.choices.length < 2) throw new UserError("A choice request needs at least two choices.");
    const req = await q<InputRequest>(c.db.from("input_requests").insert({
      owner_id: c.ownerId, task_id: task.id, run_id: run.id, kind: i.kind, reason: i.reason, question: i.question, context: i.context, blocks: i.blocks,
      choices: i.choices, asked_by: run.agent === "codex" ? "Codex" : "Claude Code",
    }).select("*").single());
    await q(c.db.from("messages").insert({ owner_id: c.ownerId, task_id: task.id, author: "agent", agent: run.agent, kind: "question", body: i.question, run_id: run.id }));
    if (!(await isLatest(c, run))) return { request_id: req.id };
    await q(c.db.from("runs").update({ state: "waiting_for_input", wait_reason: i.reason, last_heartbeat_at: now(), lease_expires_at: null }).eq("id", run.id));
    await setTask(c, task.id, { status: "needs_denny" });
    await notify(c, task.id, "input_requested", `${taskRef(task.number)}: ${i.question}`, { request_id: req.id, run_id: run.id });
    await log(c, task.id, "input_requested", `Asked: ${i.question}`, run.id);
    return { request_id: req.id };
  },

  async get_answer(c, i) {
    const r = await q<InputRequest | null>(c.db.from("input_requests").select("*").eq("id", i.request_id).maybeSingle());
    if (!r) throw new UserError("Unknown request_id.");
    return { state: r.state, answer_text: r.answer_text, answer_choice: r.answer_choice, answer_choice_text: r.answer_choice !== null ? r.choices[r.answer_choice] ?? null : null };
  },

  async get_task(c, i) {
    const task = await resolveTask(c, i.task_id);
    const [criteria, open, messages] = await Promise.all([
      q<{ position: number; text: string; agent_state: string; accepted: boolean }[]>(c.db.from("acceptance_criteria").select("*").eq("task_id", task.id).order("position")),
      q<InputRequest[]>(c.db.from("input_requests").select("*").eq("task_id", task.id).eq("state", "open")),
      q<Message[]>(c.db.from("messages").select("*").eq("task_id", task.id).order("created_at")),
    ]);
    const pending = messages.filter((m) => m.pending_for_next_run && !m.delivered_run_id);
    const active = await activeRun(c, task.id);
    if (pending.length && active) {
      await q(c.db.from("messages").update({ pending_for_next_run: false, delivered_run_id: active.id }).in("id", pending.map((m) => m.id)));
    }
    const since = i.since;
    return {
      id: taskRef(task.number), title: task.title, status: task.status, brief: task.brief,
      criteria: criteria.map((x) => ({ position: x.position, text: x.text, agent_state: x.agent_state, accepted: x.accepted })),
      open_requests: open.map((r) => ({ id: r.id, question: r.question, kind: r.kind, choices: r.choices })),
      messages: messages.filter((m) => !since || m.created_at > since).slice(-50).map((m) => ({ author: m.author, kind: m.kind, body: m.body, at: m.created_at })),
      pending_instructions: pending.map((m) => m.body),
      cursor: messages.at(-1)?.created_at ?? null,
      delivered: !!active,
    };
  },

  async submit_result(c, i) {
    const task = await resolveTask(c, i.task_id);
    const run = await sessionRun(c, task, i.session_id);
    await q(c.db.from("results").upsert({ owner_id: c.ownerId, run_id: run.id, summary: i.summary, changes: i.changes, limitations: i.limitations }, { onConflict: "run_id" }));
    if (i.checks.length) await q(c.db.from("checks").insert(i.checks.map((x) => ({ owner_id: c.ownerId, run_id: run.id, name: x.name, state: x.state, source: "agent" }))));
    if (i.artifacts.length) await q(c.db.from("artifacts").insert(i.artifacts.map((a, position) => ({ owner_id: c.ownerId, run_id: run.id, kind: a.kind, label: a.label, url: a.url ?? null, position }))));
    if (!(await isLatest(c, run))) {
      await event(c, run.id, "Result arrived from an older run. Task status unchanged.", "warn");
      return { state: "stored_only" };
    }
    const criteria = await q<{ id: string; position: number }[]>(c.db.from("acceptance_criteria").select("*").eq("task_id", task.id));
    for (const cr of criteria) {
      const s = i.criteria_states[cr.position];
      if (s) await q(c.db.from("acceptance_criteria").update({ agent_state: s, agent_run_id: run.id }).eq("id", cr.id));
    }
    await q(c.db.from("messages").insert({ owner_id: c.ownerId, task_id: task.id, author: "agent", agent: run.agent, kind: "result", body: i.summary, run_id: run.id }));
    await q(c.db.from("runs").update({ state: "completed", ended_at: now(), step: 3, step_label: "Preparing result", end_note: "Result submitted.", lease_expires_at: null }).eq("id", run.id));
    await setTask(c, task.id, { status: "review", sort_order: Date.now() });
    await notify(c, task.id, "result_ready", `${taskRef(task.number)}: result ready for review`, { run_id: run.id });
    await log(c, task.id, "result_submitted", "Submitted a result for review", run.id);
    return { state: "review" };
  },

  async report_failure(c, i) {
    const task = await resolveTask(c, i.task_id);
    const run = await sessionRun(c, task, i.session_id);
    await q(c.db.from("runs").update({
      state: "failed", ended_at: now(), error_summary: redact(i.error_summary), last_meaningful_step: i.last_step,
      partial_output: redact(i.partial_output), suggested_action: i.suggested_action, lease_expires_at: null,
    }).eq("id", run.id));
    if (!(await isLatest(c, run))) return { state: "stored_only" };
    return handleFailure(c, task, run, i.error_summary);
  },
};

/** PRD 6.2: automatic retry when allowed, otherwise Needs Denny with a takeover choice. */
export async function handleFailure(c: Ctx, task: Task, run: Run, summary: string) {
  const project = await getProject(c, task.project_id);
  if (run.worker_id) {
    const runs = await taskRuns(c, task.id);
    let streak = 0;
    for (const r of runs) {
      if (r.kind !== "retry") break;
      streak++;
    }
    if (retriesLeft(project.retry_limit, streak) && project.worker_id) {
      await createQueuedRun(c, task, project, "retry");
      await log(c, task.id, "auto_retry", `Run ${run.attempt} failed. Retry queued.`, run.id);
      return { state: "retry_queued" };
    }
  }
  const req = await q<InputRequest>(c.db.from("input_requests").insert({
    owner_id: c.ownerId, task_id: task.id, run_id: run.id, kind: "choice", reason: "retry_limit_reached", asked_by: "System",
    question: `Run ${run.attempt} failed. What should happen next?`, context: redact(summary), blocks: "This task",
    choices: ["Try again with a new run", "Leave it, I'll take over manually"], manual_choice_index: 1,
  }).select("*").single());
  await setTask(c, task.id, { status: "needs_denny" });
  await notify(c, task.id, "failure_needs_action", `${taskRef(task.number)}: run ${run.attempt} failed`, { request_id: req.id, run_id: run.id });
  await log(c, task.id, "run_failed", `Run ${run.attempt} failed`, run.id);
  return { state: "needs_denny", request_id: req.id };
}

/** Runs a tool with validation and event_id idempotency. */
export async function callTool(c: Ctx, name: ToolName, raw: unknown): Promise<unknown> {
  const input = schemas[name].parse(raw ?? {}) as { event_id?: string };
  const run = handlers[name] as (c: Ctx, i: unknown) => Promise<unknown>;
  const id = input.event_id;
  if (!id) return run(c, input);

  const claim = await c.db.from("mcp_events").insert({ event_id: id, owner_id: c.ownerId, tool: name });
  if (claim.error) {
    if (claim.error.code !== "23505") throw new Error(claim.error.message);
    const prior = await q<{ result: unknown; tool: string } | null>(c.db.from("mcp_events").select("*").eq("event_id", id).maybeSingle());
    if (prior?.tool !== name) throw new UserError("This event_id was already used by a different tool.");
    if (prior.result === null || prior.result === undefined) throw new UserError("This event is still being processed. Retry shortly.");
    return prior.result;
  }
  try {
    const result = await run(c, input);
    await q(c.db.from("mcp_events").update({ result }).eq("event_id", id));
    return result;
  } catch (e) {
    await c.db.from("mcp_events").delete().eq("event_id", id);
    throw e;
  }
}

export const toolList = () =>
  (Object.keys(schemas) as ToolName[]).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: z.toJSONSchema(schemas[name], { io: "input" }),
  }));

export const isToolName = (n: string): n is ToolName => n in schemas;

/** Minimal MCP over streamable HTTP: stateless JSON-RPC, JSON responses. */
export async function handleRpc(c: Ctx, msg: { id?: string | number | null; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } }) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "task-workspace", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList() });
    case "tools/call": {
      const name = msg.params?.name ?? "";
      if (!isToolName(name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const out = await callTool(c, name, msg.params?.arguments);
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
      } catch (e) {
        const text = e instanceof z.ZodError ? `Invalid input: ${e.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}` : e instanceof UserError ? e.message : "The tool failed on the server.";
        if (!(e instanceof z.ZodError || e instanceof UserError)) console.error(e);
        return reply({ isError: true, content: [{ type: "text", text }] });
      }
    }
    default:
      return msg.id === undefined ? null : fail(-32601, "Method not found");
  }
}
