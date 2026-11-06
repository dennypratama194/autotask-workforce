import { describe, expect, it } from "vitest";
import { checkMove, checkPrereqs, deriveNextOwner, parseTaskRef, redact, validateAnswer } from "./rules";

const base = { from: "in_progress" as const, activeRun: null, hasResult: false };

describe("checkMove", () => {
  it("blocks every move while executing", () => {
    for (const s of ["running", "pausing", "paused", "stopping"] as const)
      expect(checkMove({ ...base, activeRun: s }, "inbox")).toEqual({ ok: false, message: "Stop the run before moving it." });
  });
  it("queued and waiting may only go to Inbox", () => {
    expect(checkMove({ ...base, activeRun: "queued" }, "inbox").ok).toBe(true);
    expect(checkMove({ ...base, activeRun: "queued" }, "done").ok).toBe(false);
    expect(checkMove({ ...base, activeRun: "waiting_for_input" }, "inbox").ok).toBe(true);
    expect(checkMove({ ...base, activeRun: "waiting_for_input" }, "review")).toEqual({ ok: false, message: "Answer the open request to resume." });
  });
  it("Review requires a result", () => {
    expect(checkMove(base, "review").ok).toBe(false);
    expect(checkMove({ ...base, hasResult: true }, "review").ok).toBe(true);
  });
});

describe("deriveNextOwner", () => {
  it("follows PRD 6.3", () => {
    expect(deriveNextOwner("inbox", false, null)).toBe("none");
    expect(deriveNextOwner("ai_queue", false, null)).toBe("ai");
    expect(deriveNextOwner("in_progress", true, null)).toBe("ai");
    expect(deriveNextOwner("in_progress", false, null)).toBe("denny");
    expect(deriveNextOwner("in_progress", true, "denny")).toBe("denny");
    expect(deriveNextOwner("review", true, "ai")).toBe("denny");
    expect(deriveNextOwner("done", false, "ai")).toBe("none");
  });
});

describe("checkPrereqs", () => {
  const ok = { repo: "a/b", agent: "claude_code" as const, workerId: "w", brief: "A brief of twenty or more characters", activeRunAttempt: null };
  it("passes when complete", () => expect(checkPrereqs(ok)).toEqual([]));
  it("lists every failure with its exact message", () => {
    const out = checkPrereqs({ repo: null, agent: "codex", workerId: null, brief: "short", activeRunAttempt: 2 });
    expect(out).toHaveLength(5);
    expect(out).toContain("Run 2 is already active on this task.");
    expect(out).toContain("No worker is assigned to this project.");
  });
});

describe("validateAnswer", () => {
  it("never accepts an empty answer", () => {
    expect(validateAnswer("choice", 2, {})).toBeTruthy();
    expect(validateAnswer("choice", 2, { choice: 5 })).toBeTruthy();
    expect(validateAnswer("text", 0, { text: "  " })).toBeTruthy();
    expect(validateAnswer("asset", 0, {})).toBeTruthy();
    expect(validateAnswer("action", 0, { confirmed: false })).toBeTruthy();
    expect(validateAnswer("choice", 2, { choice: 0 })).toBeNull();
    expect(validateAnswer("asset", 0, { hasFile: true })).toBeNull();
  });
});

it("parseTaskRef accepts TW-142 and 142 only", () => {
  expect(parseTaskRef("TW-142")).toBe(142);
  expect(parseTaskRef("142")).toBe(142);
  expect(parseTaskRef("abc")).toBeNull();
});

it("redact removes secrets", () => {
  expect(redact("sk-ant-abc123 ok")).toBe("[redacted] ok");
  expect(redact("API_KEY=hunter2")).toBe("API_KEY=[redacted]");
});
