"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isFakeDb, userCtx, UserError, type Ctx } from "@/lib/server/db";
import * as e from "@/lib/server/engine";
import { createClient } from "@/lib/supabase/server";

export type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; message: string; blocked?: string[] };

async function act<S extends z.ZodType, T>(schema: S, raw: unknown, fn: (c: Ctx, i: z.infer<S>) => Promise<T>): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input." };
  try {
    return { ok: true, data: await fn(await userCtx(), parsed.data) };
  } catch (err) {
    if (err instanceof UserError) return { ok: false, message: err.message, blocked: err.blocked };
    console.error(err);
    return { ok: false, message: "That didn't save. Try again." };
  }
}

const id = z.string().min(1);
const status = z.enum(["inbox", "ai_queue", "in_progress", "needs_denny", "review", "done"]);
const owner = z.enum(["denny", "ai", "none"]);
const attachment = z.object({ storage_path: z.string(), file_name: z.string(), size_bytes: z.number(), mime: z.string().nullable() });

export const createTaskAction = async (raw: unknown) =>
  act(z.object({
    project_id: id, title: z.string().trim().min(1, "A task needs a title."), brief: z.string(), criteria: z.array(z.string()),
    reference_url: z.string().nullable().optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    due_date: z.string().nullable().optional(), run_with_ai: z.boolean().optional(),
  }), raw, async (c, i) => {
    const { task, blocked } = await e.createTask(c, i);
    return { number: task.number, id: task.id, blocked };
  });

export const moveTaskAction = async (raw: unknown) =>
  act(z.object({ id, to: status, sort_order: z.number().optional() }), raw, (c, i) => e.moveTask(c, i.id, i.to, i.sort_order));
export const reorderTaskAction = async (raw: unknown) =>
  act(z.object({ id, sort_order: z.number() }), raw, (c, i) => e.reorderTask(c, i.id, i.sort_order));
export const updateTaskAction = async (raw: unknown) =>
  act(z.object({
    id,
    patch: z.object({
      title: z.string().optional(), brief: z.string().optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      due_date: z.string().nullable().optional(), agent: z.enum(["claude_code", "codex"]).nullable().optional(),
      project_id: z.string().optional(), owner_override: owner.nullable().optional(),
    }),
  }), raw, (c, i) => e.updateTask(c, i.id, i.patch));
export const archiveTaskAction = async (raw: unknown) =>
  act(z.object({ id, archived: z.boolean() }), raw, (c, i) => e.archiveTask(c, i.id, i.archived));
export const cancelTaskAction = async (raw: unknown) => act(z.object({ id }), raw, (c, i) => e.cancelTask(c, i.id));
export const addCriterionAction = async (raw: unknown) =>
  act(z.object({ id, text: z.string().trim().min(1, "Write the criterion first.") }), raw, (c, i) => e.addCriterion(c, i.id, i.text));
export const acceptCriterionAction = async (raw: unknown) =>
  act(z.object({ id, accepted: z.boolean() }), raw, (c, i) => e.acceptCriterion(c, i.id, i.accepted));

export const sendMessageAction = async (raw: unknown) =>
  act(z.object({ task_id: id, mode: z.enum(["comment", "instruction"]), body: z.string(), client_id: id, attachments: z.array(attachment).optional() }), raw, e.sendMessage);
export const answerAction = async (raw: unknown) =>
  act(z.object({
    request_id: id, choice: z.number().nullable().optional(), text: z.string().nullable().optional(), confirmed: z.boolean().optional(),
    note: z.string().nullable().optional(), attachments: z.array(attachment).optional(),
  }), raw, e.answerRequest);

export const approveAction = async (raw: unknown) => act(z.object({ id }), raw, (c, i) => e.approve(c, i.id));
export const requestChangesAction = async (raw: unknown) =>
  act(z.object({ id, text: z.string(), client_id: id }), raw, (c, i) => e.requestChanges(c, i.id, i.text, i.client_id));
export const stopRunAction = async (raw: unknown) => act(z.object({ id }), raw, (c, i) => e.stopRun(c, i.id));
export const newRunAction = async (raw: unknown) =>
  act(z.object({ id, kind: z.enum(["retry", "initial"]) }), raw, (c, i) => e.queueNewRun(c, i.id, i.kind));
export const takeOverAction = async (raw: unknown) => act(z.object({ id }), raw, (c, i) => e.takeOver(c, i.id));

export const createProjectAction = async (raw: unknown) =>
  act(z.object({ name: z.string().trim().min(1, "Name the project."), purpose: z.string().optional(), context: z.string().optional(), repo: z.string().nullable().optional() }), raw, async (c, i) => {
    const p = await e.createProject(c, i);
    return { id: p.id, slug: p.slug };
  });
export const updateProjectAction = async (raw: unknown) =>
  act(z.object({
    id,
    patch: z.object({
      name: z.string().min(1).optional(), purpose: z.string().optional(), context: z.string().optional(), repo: z.string().nullable().optional(),
      base_branch: z.string().nullable().optional(), preview_url: z.string().nullable().optional(), worker_id: z.string().nullable().optional(),
      default_agent: z.enum(["claude_code", "codex"]).nullable().optional(), verification_commands: z.array(z.string()).optional(),
      retry_limit: z.number().int().min(0).max(2).optional(), time_limit_minutes: z.number().int().min(1).max(600).optional(),
      pinned: z.boolean().optional(), archived: z.boolean().optional(),
    }),
  }), raw, (c, i) => e.updateProject(c, i.id, i.patch));

export const markReadAction = async (raw: unknown) => act(z.object({ id }), raw, (c, i) => e.markRead(c, i.id));
export const updateSettingsAction = async (raw: unknown) =>
  act(z.object({ timezone: z.string().optional(), setup_step: z.number().optional(), setup_completed: z.boolean().optional() }), raw, e.updateSettings);
export const issueTokenAction = async (raw: unknown) =>
  act(z.object({ key: z.enum(["claude_code_mcp", "codex_mcp"]) }), raw, async (c, i) => ({ token: await e.issueIntegrationToken(c, i.key) }));
export const revokeTokenAction = async (raw: unknown) =>
  act(z.object({ key: z.enum(["claude_code_mcp", "codex_mcp"]) }), raw, (c, i) => e.revokeIntegrationToken(c, i.key));
export const registerWorkerAction = async (raw: unknown) =>
  act(z.object({ name: z.string().trim().min(1, "Name the worker."), machine_label: z.string() }), raw, e.registerWorker);
export const revokeWorkerAction = async (raw: unknown) => act(z.object({ id }), raw, (c, i) => e.revokeWorker(c, i.id));

export async function signOutAction() {
  if (!isFakeDb()) await (await createClient()).auth.signOut();
  redirect("/login");
}
