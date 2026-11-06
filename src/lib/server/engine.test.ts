import { beforeEach, describe, expect, it } from "vitest";
import type { Run, Task } from "@/lib/domain/types";
import type { Ctx, Db } from "./db";
import { FakeDb } from "./fake-db";
import { answerRequest, createTask, moveTask, q, requestChanges, sendMessage, stopRun, sweep } from "./engine";
import { callTool, handleRpc } from "./mcp";
import { beat, claim, finish } from "./worker-api";

let fake: FakeDb;
let c: Ctx;
const ev = () => crypto.randomUUID();

async function project(worker = false) {
  const w = worker ? await q<{ id: string }>(c.db.from("workers").insert({ owner_id: "o", name: "Denny-PC", state: "online" }).select("*").single()) : null;
  const p = await q<{ id: string; slug: string }>(c.db.from("projects").insert({ owner_id: "o", slug: `p${Math.random()}`, name: "P", repo: "a/b", base_branch: "main", default_agent: "claude_code", worker_id: w?.id ?? null, retry_limit: 1 }).select("*").single());
  return { project_id: p.id, slug: p.slug, worker_id: w?.id ?? "" };
}
const task = async (project_id: string) =>
  (await createTask(c, { project_id, title: "T", brief: "A brief long enough to act on it", criteria: ["one"] })).task;
const reload = (id: string) => q<Task>(c.db.from("tasks").select("*").eq("id", id).single());
const runsOf = (id: string) => q<Run[]>(c.db.from("runs").select("*").eq("task_id", id).order("attempt"));

beforeEach(() => {
  fake = new FakeDb();
  c = { db: fake as unknown as Db, ownerId: "o", actor: "Denny" };
});

describe("task moves", () => {
  it("refuses Review without a result and keeps the status", async () => {
    const { project_id } = await project();
    const t = await task(project_id);
    await expect(moveTask(c, t.id, "review")).rejects.toThrow("Review needs a submitted result");
    expect((await reload(t.id)).status).toBe("inbox");
  });

  it("allows AI Queue as a plain status when no worker exists, with no run", async () => {
    const { project_id } = await project();
    const t = await task(project_id);
    expect((await moveTask(c, t.id, "ai_queue")).message).toContain("tracking only");
    expect(await runsOf(t.id)).toHaveLength(0);
  });

  it("creates a queued run when a worker is assigned", async () => {
    const { project_id } = await project(true);
    const t = await task(project_id);
    await moveTask(c, t.id, "ai_queue");
    const [r] = await runsOf(t.id);
    expect(r?.state).toBe("queued");
    await expect(moveTask(c, t.id, "done")).rejects.toThrow("queued");
  });

  it("moving a queued task to Inbox cancels the run", async () => {
    const { project_id } = await project(true);
    const t = await task(project_id);
    await moveTask(c, t.id, "ai_queue");
    await moveTask(c, t.id, "inbox");
    expect((await runsOf(t.id))[0]?.state).toBe("cancelled");
  });
});

describe("composer", () => {
  it("a comment never creates a run, and client_id dedupes", async () => {
    const { project_id } = await project(true);
    const t = await task(project_id);
    const id = ev();
    await sendMessage(c, { task_id: t.id, mode: "comment", body: "hi", client_id: id });
    await sendMessage(c, { task_id: t.id, mode: "comment", body: "hi", client_id: id });
    expect(await runsOf(t.id)).toHaveLength(0);
    expect(await q<unknown[]>(c.db.from("messages").select("*").eq("task_id", t.id))).toHaveLength(1);
  });

  it("an instruction during a run stays pending", async () => {
    const { project_id } = await project(true);
    const t = await task(project_id);
    await sendMessage(c, { task_id: t.id, mode: "instruction", body: "first", client_id: ev() });
    const r = await sendMessage(c, { task_id: t.id, mode: "instruction", body: "second", client_id: ev() });
    expect(r.message).toContain("Pending");
    expect(await runsOf(t.id)).toHaveLength(1);
  });
});

describe("MCP reporting (phase 1)", () => {
  const ref = (t: Task) => `TW-${t.number}`;

  it("runs the full loop: link, ask, answer, read, submit, changes, approve", async () => {
    const { project_id } = await project();
    const t = await task(project_id);
    await callTool(c, "link_session", { task_id: ref(t), session_id: "s1", event_id: ev() });
    expect((await reload(t.id)).status).toBe("in_progress");
    expect((await reload(t.id)).next_owner).toBe("ai");

    const { request_id } = (await callTool(c, "ask_denny", { task_id: ref(t), session_id: "s1", question: "Which?", kind: "choice", choices: ["A", "B"], event_id: ev() })) as { request_id: string };
    expect((await reload(t.id)).status).toBe("needs_denny");
    expect(((await callTool(c, "get_answer", { request_id })) as { state: string }).state).toBe("open");

    await answerRequest(c, { request_id, choice: 1 });
    expect((await callTool(c, "get_answer", { request_id })) as object).toMatchObject({ state: "resolved", answer_choice: 1, answer_choice_text: "B" });
    expect((await reload(t.id))).toMatchObject({ status: "in_progress", next_owner: "ai" });

    await callTool(c, "submit_result", { task_id: ref(t), session_id: "s1", summary: "Did it", checks: [{ name: "Build", state: "Passed" }], event_id: ev() });
    expect((await reload(t.id))).toMatchObject({ status: "review", next_owner: "denny" });

    const r = await requestChanges(c, t.id, "Make the header smaller please", ev());
    expect(r.message).toContain("get_task");
    const got = (await callTool(c, "get_task", { task_id: ref(t) })) as { pending_instructions: string[] };
    expect(got.pending_instructions).toEqual(["Make the header smaller please"]);
  });

  it("replaying an event_id returns the original result and creates nothing", async () => {
    const { slug } = await project();
    const event_id = ev();
    const a = await callTool(c, "create_task", { project_slug: slug, title: "X", brief: "", event_id });
    const b = await callTool(c, "create_task", { project_slug: slug, title: "X", brief: "", event_id });
    expect(a).toEqual(b);
    expect(await q<unknown[]>(c.db.from("tasks").select("*"))).toHaveLength(1);
  });

  it("a failed tool releases its event_id so a retry can succeed", async () => {
    const event_id = ev();
    await expect(callTool(c, "create_task", { project_slug: "nope", title: "X", event_id })).rejects.toThrow("No project");
    expect(await q<unknown[]>(c.db.from("mcp_events").select("*"))).toHaveLength(0);
  });

  it("a late result from an older run does not change status", async () => {
    const { project_id } = await project();
    const t = await task(project_id);
    await callTool(c, "link_session", { task_id: ref(t), session_id: "old", event_id: ev() });
    await stopRun(c, t.id);
    await callTool(c, "link_session", { task_id: ref(t), session_id: "new", event_id: ev() });
    const out = await callTool(c, "submit_result", { task_id: ref(t), session_id: "old", summary: "late", event_id: ev() });
    expect(out).toEqual({ state: "stored_only" });
    expect((await reload(t.id)).status).toBe("in_progress");
  });

  it("speaks JSON-RPC and reports invalid input as a tool error", async () => {
    const list = (await handleRpc(c, { id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((x) => x.name)).toContain("submit_result");
    const bad = (await handleRpc(c, { id: 2, method: "tools/call", params: { name: "create_task", arguments: {} } })) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
  });
});

describe("worker (phase 2)", () => {
  async function queued() {
    const p = await project(true);
    const t = await task(p.project_id);
    await moveTask(c, t.id, "ai_queue");
    return { ...p, t };
  }

  it("queued → question → answered → continuation → result", async () => {
    const { t, worker_id } = await queued();
    const first = (await claim(c, worker_id)) as { run: Run };
    expect(first.run.state).toBe("running");
    const { request_id } = (await callTool(c, "ask_denny", { task_id: `TW-${t.number}`, session_id: first.run.id, question: "Q?", event_id: ev() })) as { request_id: string };
    await finish(c, worker_id, { run_id: first.run.id, outcome: "ended" });
    expect((await runsOf(t.id))[0]?.state).toBe("waiting_for_input");

    expect((await answerRequest(c, { request_id, text: "Use A" })).message).toContain("continuation");
    const runs = await runsOf(t.id);
    expect(runs.map((r) => [r.kind, r.state])).toEqual([["initial", "completed"], ["continuation", "queued"]]);

    const next = (await claim(c, worker_id)) as { run: Run; conversation: { body: string }[] };
    expect(next.conversation.map((m) => m.body)).toContain("Use A");
    await callTool(c, "submit_result", { task_id: `TW-${t.number}`, session_id: next.run.id, summary: "Done", event_id: ev() });
    await finish(c, worker_id, { run_id: next.run.id, outcome: "ended" });
    expect((await reload(t.id)).status).toBe("review");
  });

  it("one writer per project: the second task waits", async () => {
    const { project_id, worker_id } = await queued();
    const t2 = await task(project_id);
    await moveTask(c, t2.id, "ai_queue");
    expect(((await claim(c, worker_id)) as { run: Run | null }).run).not.toBeNull();
    expect(((await claim(c, worker_id)) as { run: Run | null }).run).toBeNull();
  });

  it("stop: heartbeat tells the worker, finish cancels and keeps the task", async () => {
    const { t, worker_id } = await queued();
    const { run } = (await claim(c, worker_id)) as { run: Run };
    await stopRun(c, t.id);
    expect(await beat(c, worker_id, { run_id: run.id })).toMatchObject({ stop: true });
    await finish(c, worker_id, { run_id: run.id, outcome: "stopped" });
    expect((await runsOf(t.id))[0]?.state).toBe("cancelled");
    expect(await reload(t.id)).toMatchObject({ status: "in_progress", next_owner: "denny" });
  });

  it("failure retries once, then asks Denny", async () => {
    const { t, worker_id } = await queued();
    const one = (await claim(c, worker_id)) as { run: Run };
    await finish(c, worker_id, { run_id: one.run.id, outcome: "failed", error_summary: "boom" });
    const two = (await claim(c, worker_id)) as { run: Run };
    expect(two.run.kind).toBe("retry");
    await finish(c, worker_id, { run_id: two.run.id, outcome: "failed", error_summary: "boom token=abc" });
    expect((await reload(t.id)).status).toBe("needs_denny");
    expect((await runsOf(t.id))[1]?.error_summary).toBe("boom token=[redacted]");
  });

  it("usage limit interrupts the run and holds the queue", async () => {
    const { t, worker_id, project_id } = await queued();
    const { run } = (await claim(c, worker_id)) as { run: Run };
    await finish(c, worker_id, { run_id: run.id, outcome: "usage_limit" });
    expect((await runsOf(t.id))[0]?.state).toBe("interrupted");
    const t2 = await task(project_id);
    await moveTask(c, t2.id, "ai_queue");
    expect(((await claim(c, worker_id)) as { run: Run | null }).run).toBeNull();
  });

  it("the sweeper interrupts a run whose lease expired", async () => {
    const { t, worker_id } = await queued();
    const { run } = (await claim(c, worker_id)) as { run: Run };
    await q(c.db.from("runs").update({ lease_expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", run.id));
    await sweep(c);
    const [r] = await runsOf(t.id);
    expect(r?.state).toBe("interrupted");
    expect(r?.end_note).toContain("No heartbeat from Denny-PC");
  });
});
