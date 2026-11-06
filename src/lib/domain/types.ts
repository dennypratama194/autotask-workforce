export type TaskStatus = "inbox" | "ai_queue" | "in_progress" | "needs_denny" | "review" | "done";
export type NextOwner = "denny" | "ai" | "none";
export type Priority = "low" | "normal" | "high" | "urgent";
export type AgentKind = "claude_code" | "codex";
export type TaskSource = "platform" | "claude_code_vscode" | "claude_code_cli" | "codex_cli" | "chatgpt";
export type MessageKind = "comment" | "instruction" | "answer" | "update" | "question" | "result" | "system";
export type RequestKind = "choice" | "text" | "asset" | "action";
export type RequestState = "open" | "resolved" | "withdrawn";
export type RequestReason =
  | "decision_required" | "waiting_for_asset" | "authentication_required"
  | "access_required" | "retry_limit_reached" | "usage_limit_reached" | "other";
export type RunState =
  | "queued" | "running" | "waiting_for_input" | "pausing" | "paused"
  | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
export type RunKind = "initial" | "continuation" | "changes" | "retry" | "instruction" | "external";
export type CheckState = "passed" | "failed" | "not_run" | "unknown";
export type ArtifactKind = "preview" | "screenshot" | "pr" | "commit" | "document" | "change_summary";
export type WorkerState = "online" | "busy" | "offline" | "needs_setup" | "auth_required";
export type IntegrationState = "not_configured" | "connected" | "needs_auth" | "error" | "unavailable";

export type Project = {
  id: string; owner_id: string; slug: string; name: string; purpose: string; context: string;
  repo: string | null; base_branch: string | null; preview_url: string | null; reference_links: string[];
  worker_id: string | null; default_agent: AgentKind | null; verification_commands: string[];
  retry_limit: number; time_limit_minutes: number; pinned: boolean; archived: boolean;
};

export type Task = {
  id: string; owner_id: string; created_at: string; updated_at: string; number: number; project_id: string;
  title: string; brief: string; status: TaskStatus; next_owner: NextOwner; owner_override: NextOwner | null;
  agent: AgentKind | null; priority: Priority; due_date: string | null; source: TaskSource; sort_order: number;
  archived_at: string | null; cancelled_at: string | null; accepted_at: string | null;
  brief_changed_during_run: boolean; last_viewed_at: string | null; reference_url: string | null;
};

export type Run = {
  id: string; task_id: string; created_at: string; attempt: number; kind: RunKind; agent: AgentKind;
  worker_id: string | null; external_session_id: string | null; state: RunState; step: number;
  step_label: string | null; note: string | null; brief_snapshot: string | null;
  criteria_snapshot: unknown; instructions_snapshot: unknown; branch: string | null; worktree_path: string | null;
  queued_at: string; claimed_at: string | null; started_at: string | null; ended_at: string | null;
  last_heartbeat_at: string | null; lease_expires_at: string | null; error_summary: string | null;
  last_meaningful_step: string | null; partial_output: string | null; suggested_action: string | null;
  end_note: string | null; wait_reason: string | null; usage: unknown;
  stop_requested_at: string | null; pause_requested_at: string | null; owner_id: string;
};

export type InputRequest = {
  id: string; task_id: string; run_id: string | null; created_at: string; kind: RequestKind; reason: RequestReason;
  question: string; context: string; blocks: string; choices: string[]; manual_choice_index: number | null;
  required: boolean; state: RequestState; answer_text: string | null; answer_choice: number | null;
  answered_at: string | null; asked_by: string;
};

export type Message = {
  id: string; task_id: string; created_at: string; author: "denny" | "agent" | "system"; agent: AgentKind | null;
  kind: MessageKind; body: string; run_id: string | null; pending_for_next_run: boolean;
  delivered_run_id: string | null; client_id: string | null;
};

export type Criterion = {
  id: string; task_id: string; position: number; text: string; agent_state: CheckState; accepted: boolean;
};
export type Check = { id: string; run_id: string; name: string; state: CheckState; source: "agent" | "owner"; detail: string | null };
export type Result = { id: string; run_id: string; created_at: string; summary: string; changes: string[]; limitations: string[] };
export type Artifact = {
  id: string; run_id: string; kind: ArtifactKind; label: string; url: string | null;
  storage_path: string | null; issue: string | null; position: number;
};
export type RunEvent = { id: string; run_id: string; at: string; level: string; text: string };
export type Activity = { id: string; task_id: string; run_id: string | null; actor: string; action: string; text: string; at: string };
export type Notification = {
  id: string; task_id: string; request_id: string | null; run_id: string | null;
  kind: "input_requested" | "result_ready" | "failure_needs_action"; text: string; read_at: string | null;
  group_key: string; created_at: string;
};
export type Worker = {
  id: string; name: string; machine_label: string | null; state: WorkerState; supported_agents: AgentKind[];
  last_seen_at: string | null; max_concurrent_runs: number; held_until: string | null; hold_reason: string | null;
};
export type Integration = { id: string; key: string; state: IntegrationState; last_success_at: string | null; has_token: boolean };
export type Settings = { id: string; timezone: string; setup_completed_at: string | null; setup_step: number };
export type Attachment = {
  id: string; task_id: string; message_id: string | null; request_id: string | null; storage_path: string;
  file_name: string; size_bytes: number; mime: string | null; state: string; url?: string | null;
};

export type Snapshot = {
  projects: Project[]; tasks: Task[]; runs: Run[]; requests: InputRequest[]; checks: Check[];
  resultRunIds: string[]; notifications: Notification[]; activity: Activity[]; workers: Worker[];
  integrations: Integration[]; settings: Settings | null;
};

export type TaskDetail = {
  task: Task; project: Project; criteria: Criterion[]; messages: Message[]; requests: InputRequest[];
  runs: Run[]; events: RunEvent[]; checks: Check[]; results: Result[]; artifacts: Artifact[];
  activity: Activity[]; attachments: Attachment[]; worker: Worker | null; workers: Worker[];
};
