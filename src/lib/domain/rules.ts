import type { AgentKind, NextOwner, RunState, TaskStatus } from "./types";

export const STATUSES: TaskStatus[] = ["inbox", "ai_queue", "in_progress", "needs_denny", "review", "done"];
export const ACTIVE_RUN_STATES: RunState[] = ["queued", "running", "waiting_for_input", "pausing", "paused", "stopping"];
export const EXECUTING_RUN_STATES: RunState[] = ["running", "pausing", "paused", "stopping"];

export const isActive = (s: RunState | null | undefined) => !!s && ACTIVE_RUN_STATES.includes(s);
export const isExecuting = (s: RunState | null | undefined) => !!s && EXECUTING_RUN_STATES.includes(s);

export type MoveCheck = { ok: true } | { ok: false; message: string };

export const REVIEW_NEEDS_RESULT = "Review needs a submitted result. For work you did yourself, move it to Done.";
export const STOP_BEFORE_MOVING = "Stop the run before moving it.";
export const ANSWER_TO_RESUME = "Answer the open request to resume.";
export const QUEUED_NO_MOVE = "This task is queued. Remove it from the queue before moving it.";

/** PRD 6.1. AI Queue prerequisites are checked separately by checkPrereqs. */
export function checkMove(
  input: { from: TaskStatus; activeRun: RunState | null; hasResult: boolean },
  to: TaskStatus,
): MoveCheck {
  const { from, activeRun, hasResult } = input;
  if (from === to) return { ok: false, message: "The task is already in this status." };
  if (isExecuting(activeRun)) return { ok: false, message: STOP_BEFORE_MOVING };
  if (activeRun === "queued" && to !== "inbox") return { ok: false, message: QUEUED_NO_MOVE };
  if (activeRun === "waiting_for_input" && to !== "inbox") return { ok: false, message: ANSWER_TO_RESUME };
  if (to === "review" && !hasResult) return { ok: false, message: REVIEW_NEEDS_RESULT };
  return { ok: true };
}

/** PRD 6.3 */
export function deriveNextOwner(status: TaskStatus, runRunning: boolean, override: NextOwner | null): NextOwner {
  switch (status) {
    case "ai_queue":
      return "ai";
    case "in_progress":
      return override ?? (runRunning ? "ai" : "denny");
    case "needs_denny":
    case "review":
      return "denny";
    default:
      return "none";
  }
}

export type PrereqInput = {
  repo: string | null;
  agent: AgentKind | null;
  workerId: string | null;
  brief: string;
  activeRunAttempt: number | null;
};

/** PRD 6.4, exact messages. */
export function checkPrereqs(p: PrereqInput): string[] {
  const out: string[] = [];
  if (!p.repo) out.push("This project has no repository. Coding runs need one (Project settings › Repository).");
  if (p.agent === "codex")
    out.push("Codex can't execute work yet; its adapter is planned for a later stage. Switch the agent to Claude Code.");
  if (!p.workerId) out.push("No worker is assigned to this project.");
  if (p.brief.trim().length < 20)
    out.push("The brief is too short to act on. Describe the outcome in a sentence or two.");
  if (p.activeRunAttempt !== null) out.push(`Run ${p.activeRunAttempt} is already active on this task.`);
  return out;
}

export const CHANGES_MIN = 12;
export const CHANGES_ERROR =
  "Describe what should change so the agent can act on it, for example a size, a section or a behavior.";

export type AnswerInput = { choice?: number | null; text?: string | null; confirmed?: boolean; hasFile?: boolean };

/** PRD 7.3 step 1. Returns an error message, or null when valid. */
export function validateAnswer(
  kind: "choice" | "text" | "asset" | "action",
  choiceCount: number,
  a: AnswerInput,
): string | null {
  const text = a.text?.trim();
  if (kind === "choice") {
    if (a.choice === null || a.choice === undefined) return "Choose an option.";
    if (a.choice < 0 || a.choice >= choiceCount) return "Choose one of the listed options.";
  }
  if (kind === "text" && !text) return "Type your answer.";
  if (kind === "asset" && !text && !a.hasFile) return "Attach a file or describe where to find it.";
  if (kind === "action" && !a.confirmed) return "Confirm that you've done this.";
  return null;
}

/** Automatic retry is allowed while the number of retries in a row is under the project limit. */
export function retriesLeft(retryLimit: number, consecutiveRetries: number): boolean {
  return consecutiveRetries < retryLimit;
}

export function parseTaskRef(ref: string): number | null {
  const m = /^(?:TW-)?(\d+)$/i.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

export const taskRef = (n: number) => `TW-${n}`;

const SECRET_PATTERNS = [
  /sk-ant-[\w-]+/g,
  /sb_secret_[\w-]+/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi,
];

/** PRD 12: redact tokens and env values from logs before storing. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (t, p) => t.replace(p, (m, prefix) => (typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]")),
    text,
  );
}
