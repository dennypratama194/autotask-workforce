import { z } from "zod";
import type { Project, Run, Task } from "@/lib/domain/types";
import { redact } from "@/lib/domain/rules";
import { hashToken, type Ctx, type Db } from "./db";
import { getProject, getTask, log, notify, now, q, setTask, sweep } from "./engine";
import { handleFailure } from "./mcp";

const LEASE_MS = 90_000;
type W = { id: string; owner_id: string; name: string };

export async function authWorker(db: Db, token: string): Promise<(W & { ctx: Ctx }) | null> {
  const r = await q<W[]>(db.from("workers").select("id, owner_id, name").eq("token_hash", hashToken(token)).limit(1));
  const w = r[0];
  return w ? { ...w, ctx: { db, ownerId: w.owner_id, actor: w.name } } : null;
}

async function owned(c: Ctx, workerId: string, runId: string) {
  const r = await q<Run | null>(c.db.from("runs").select("*").eq("id", runId).eq("worker_id", workerId).maybeSingle());
  if (!r) throw new Error("Run does not belong to this worker.");
  return r;
}

const seen = (c: Ctx, id: string, state: string) =>
  q(c.db.from("workers").update({ state, last_seen_at: now(), supported_agents: ["claude_code"] }).eq("id", id));

export async function claim(c: Ctx, workerId: string) {
  await sweep(c);
  const rows = await q<Run[]>(c.db.rpc("claim_run", { p_worker: workerId, p_lease_seconds: LEASE_MS / 1000 }));
  const run = rows[0];
  await seen(c, workerId, run ? "busy" : "online");
  if (!run) return { run: null };

  const task = await getTask(c, run.task_id);
  const project: Project = await getProject(c, task.project_id);
  await setTask(c, task.id, { status: "in_progress", owner_override: null });

  // PRD 7.2: instructions saved earlier are delivered as this run starts.
  const pending = await q<{ id: string; body: string }[]>(c.db.from("messages").select("*").eq("task_id", task.id).eq("pending_for_next_run", true));
  if (pending.length) await q(c.db.from("messages").update({ pending_for_next_run: false, delivered_run_id: run.id }).in("id", pending.map((m) => m.id)));

  const prior = await q<Run[]>(c.db.from("runs").select("*").eq("task_id", task.id).order("attempt", { ascending: false }));
  const priorIds = prior.filter((r) => r.id !== run.id).map((r) => r.id);
  const results = priorIds.length ? await q<{ summary: string; created_at: string }[]>(c.db.from("results").select("*").in("run_id", priorIds).order("created_at", { ascending: false }).limit(1)) : [];
  // Answers and instructions so far, read now so a pending instruction made after queueing is included.
  const conversation = await q<{ kind: string; body: string }[]>(c.db.from("messages").select("*").eq("task_id", task.id).in("kind", ["instruction", "answer"]).order("created_at"));

  await log(c, task.id, "run_started", `Run ${run.attempt} started`, run.id);
  return {
    run,
    task: { id: task.id, number: task.number, title: task.title },
    project: { slug: project.slug, repo: project.repo, base_branch: project.base_branch, context: project.context, verification_commands: project.verification_commands, time_limit_minutes: project.time_limit_minutes },
    conversation: conversation.map((m) => ({ kind: m.kind, body: m.body })),
    previous_result: results[0]?.summary ?? null,
  };
}

const heartbeat = z.object({ run_id: z.string().optional() });
export async function beat(c: Ctx, workerId: string, raw: unknown) {
  const { run_id } = heartbeat.parse(raw ?? {});
  await sweep(c);
  if (!run_id) {
    await seen(c, workerId, "online");
    return { stop: false };
  }
  const run = await owned(c, workerId, run_id);
  await seen(c, workerId, "busy");
  if (!["running", "stopping"].includes(run.state)) return { stop: run.state !== "waiting_for_input", state: run.state };
  await q(c.db.from("runs").update({ last_heartbeat_at: now(), lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString() }).eq("id", run.id));
  return { stop: run.state === "stopping", state: run.state };
}

const finishSchema = z.object({
  run_id: z.string(),
  outcome: z.enum(["stopped", "failed", "usage_limit", "no_result", "ended"]),
  error_summary: z.string().optional(),
  partial_output: z.string().optional(),
  resets_at: z.string().optional(),
  usage: z.unknown().optional(),
  auth_error: z.boolean().optional(),
});

/** The SDK call has ended. Applies the terminal state the agent tools didn't already set. */
export async function finish(c: Ctx, workerId: string, raw: unknown) {
  const f = finishSchema.parse(raw);
  const run = await owned(c, workerId, f.run_id);
  if (f.usage !== undefined) await q(c.db.from("runs").update({ usage: f.usage }).eq("id", run.id));
  const task: Task = await getTask(c, run.task_id);
  await seen(c, workerId, "online");

  if (f.outcome === "ended" && !["running", "stopping"].includes(run.state)) return { state: run.state };

  if (f.outcome === "stopped" || run.state === "stopping") {
    await q(c.db.from("runs").update({
      state: "cancelled", ended_at: now(), lease_expires_at: null,
      end_note: `Stopped during ${run.step_label ?? "Reading project"}. Partial work is kept on branch ${run.branch}.`,
    }).eq("id", run.id));
    await setTask(c, task.id, { status: "in_progress", owner_override: "denny" });
    await log(c, task.id, "run_stopped", `Run ${run.attempt} stopped`, run.id);
    return { state: "cancelled" };
  }
  if (f.outcome === "usage_limit") {
    const at = f.resets_at ? new Date(f.resets_at) : null;
    const label = at ? at.toISOString() : "later";
    await q(c.db.from("runs").update({
      state: "interrupted", ended_at: now(), lease_expires_at: null, wait_reason: `Usage limit reached · resets at ${label}`,
      end_note: "Usage limit reached. Partial work is kept. Retry as a new run after the reset.",
    }).eq("id", run.id));
    await q(c.db.from("workers").update({
      held_until: (at ?? new Date(Date.now() + 3_600_000)).toISOString(), hold_reason: `Usage limit reached · resets at ${label}`,
    }).eq("id", workerId));
    await setTask(c, task.id, { status: "in_progress" });
    await notify(c, task.id, "failure_needs_action", `Usage limit reached on ${run.branch}. The queue is held.`, { run_id: run.id });
    return { state: "interrupted" };
  }
  // Failure, or the agent ended without calling submit_result, ask_denny or report_failure.
  const summary = redact(f.error_summary ?? "The agent ended without submitting a result.");
  await q(c.db.from("runs").update({
    state: "failed", ended_at: now(), lease_expires_at: null, error_summary: summary, partial_output: redact(f.partial_output ?? ""),
    last_meaningful_step: run.step_label, suggested_action: f.auth_error ? "Fix connection: run `claude setup-token` or log in on the worker." : "Retry as a new run.",
  }).eq("id", run.id));
  if (f.auth_error) await q(c.db.from("workers").update({ state: "auth_required" }).eq("id", workerId));
  return handleFailure(c, task, { ...run, state: "failed" }, summary);
}

export async function appendLog(c: Ctx, workerId: string, raw: unknown) {
  const i = z.object({ run_id: z.string(), text: z.string(), level: z.string().default("info"), worktree_path: z.string().optional(), step: z.number().int().min(0).max(3).optional() }).parse(raw);
  await owned(c, workerId, i.run_id);
  await q(c.db.from("run_events").insert({ owner_id: c.ownerId, run_id: i.run_id, text: redact(i.text).slice(0, 4000), level: i.level, at: now() }));
  const LABELS = ["Reading project", "Editing files", "Running checks", "Preparing result"];
  if (i.worktree_path || i.step !== undefined) {
    await q(c.db.from("runs").update({
      ...(i.worktree_path ? { worktree_path: i.worktree_path } : {}),
      ...(i.step !== undefined ? { step: i.step, step_label: LABELS[i.step] } : {}),
    }).eq("id", i.run_id));
  }
  return { ok: true };
}

export async function addArtifact(c: Ctx, workerId: string, raw: unknown) {
  const i = z.object({ run_id: z.string(), kind: z.enum(["pr", "commit"]), label: z.string(), url: z.string().nullable() }).parse(raw);
  await owned(c, workerId, i.run_id);
  await q(c.db.from("artifacts").insert({ owner_id: c.ownerId, run_id: i.run_id, kind: i.kind, label: i.label, url: i.url, position: 100 }));
  return { ok: true };
}
