# Task Workspace · Build PRD v2

Version 2.0 · 6 November 2026
Owner: Denny Pratama
Audience: Claude Code, building the product in this repository
Supersedes: AI Task Workspace PRD v1.0 (design phase)
Design reference: the Task Workspace design canvas (https://claude.ai/artifact/34oFXjBDdRYQATiL9cJGbV). Frame IDs such as `T08` below refer to artboards on that canvas.

---

## 0. How to use this document (read first, Claude Code)

1. Build in the milestone order in section 14. Finish, test and commit each milestone before starting the next.
2. The canvas prototype is a **visual and behavioural reference only**. It is a single mock file with fake state. Do not port its code or its state logic. Rebuild properly with the stack below.
3. When this document and the canvas disagree, this document wins. When this document is silent, follow the canvas. When both are silent, choose the simplest option and add it to `docs/DECISIONS.md`.
4. Never fake a real connection. Anything not built yet is shown as disabled with a one-line reason.
5. Ask Denny only when a decision is irreversible or contradicts this document. Otherwise decide, log it and continue.

---

## 1. Product in one paragraph

A private, single-user web app where Denny tracks work across client and personal projects that he does with Claude Code. Each task is one outcome with a durable ID, a brief, acceptance criteria, a conversation, questions that need Denny, run history and reviewable results. Phase 1 is a tracking app that Denny's normal Claude Code sessions report into through an MCP server. Phase 2 adds a worker that launches Claude Code runs by itself through the Claude Agent SDK. The app is personal. It will not be sold or shared.

### Product promise
Open one screen and know immediately: what needs me, what is AI working on, what is queued, what is ready for review, and what changed.

### Non-goals (never build without a new decision)
- Multi-user, teams, orgs, client portals, billing, public signup.
- Document editor, wiki, calendar, Gantt, time tracking, sprints.
- General chat unrelated to tasks.
- Agents delegating to agents. More than one coding writer per project.
- Mirroring full Claude or Codex chat histories.
- Automatic merge, production deploy, destructive data changes, client messaging or spending.

---

## 2. Decisions locked since v1

| Topic | Decision |
|---|---|
| Users | One owner (Denny). No sharing. Personal use only. |
| Billing for agent runs | Denny's Claude subscription via OAuth login. Agent SDK and `claude -p` usage draws from the plan's 5-hour and weekly limits, shared with interactive use. No API key in v1. If the app is ever sold or shared, switch to API keys. |
| Phase 1 scope | Tracking app plus MCP reporting from existing Claude Code sessions. No worker. |
| Phase 2 scope | Worker with Claude Agent SDK, one adapter (Claude Code), Stop supported, Pause shipped disabled unless the spike proves a safe pause. |
| Answering a question | Resolves the request. In Phase 2 it ends the waiting run and queues a **new continuation run**. A run never sleeps waiting for a human. |
| Next owner | Derived from status by default (table in 6.3). Manual override allowed only while status is In Progress. |
| Waiting runs and the project lock | A run in `waiting_for_input` does **not** hold the project writer lock. Its worktree is kept, and the continuation run reuses it. |
| Codex | Appears only as a task source and in run history. Execution adapter shown as "Not available yet". |
| Usage limit | New waiting reason: "Usage limit reached · resets at HH:MM". The run becomes Interrupted, partial work kept, queue held. |
| Sample data | Seed script only, behind `pnpm seed`. Never shipped as live data. |

---

## 3. Stack

| Layer | Choice |
|---|---|
| App | Next.js (App Router), TypeScript strict, React Server Components where it helps |
| UI | Tailwind CSS, shadcn/ui (Radix primitives), lucide-react icons |
| Drag and drop | dnd-kit with keyboard sensors, plus a Move menu on every card |
| Data, auth, files | Supabase Postgres, Supabase Auth (email magic link, single allowed email), Supabase Storage |
| Live updates | Supabase Realtime on `tasks`, `messages`, `input_requests`, `runs`, `notifications` with refetch on reconnect |
| Validation | zod for every API input and MCP tool input |
| Server state | TanStack Query on the client, server actions or route handlers for writes |
| Hosting | Vercel (existing account) |
| MCP server | Route handler at `/api/mcp` speaking MCP over streamable HTTP, bearer-token auth |
| Worker (Phase 2) | Node.js 20+ process using `@anthropic-ai/claude-agent-sdk`, runs on Denny's PC (Windows with WSL2) or a VPS |
| Tests | Vitest for logic, Playwright for the core flows and the 390 px layout |
| Package manager | pnpm |

Before writing worker code, check the current Agent SDK docs for exact API names (custom tools, abort, session resume, auth). Do not rely on memory.

---

## 4. Information architecture

### Desktop (1440 primary; must work at 1024 and 768)
Left sidebar, 232 px:
- Overview
- All tasks (Kanban and List toggle)
- Needs Denny (attention count = open requests + reviews)
- Projects
- Settings
- Pinned projects (with "N need you")
- Worker status block (Phase 2; in Phase 1 shows "No worker · tracking only")

Top bar: page title and subtitle, global search, notifications bell with unread count, New task.

Task detail opens as a right-side panel (max 900 px, never narrower than readable) with "Open as page". Deep link `/tasks/TW-142` opens it directly. Esc closes. Focus returns to the element that opened it.

### Mobile (390 to 430)
Bottom tab bar: Overview, Needs Denny (count), Tasks, Projects, Settings. Tasks defaults to List. Kanban still available with horizontal scroll. Task detail is a full-screen page, browser Back returns to the previous view with filters kept. Composer is pinned to the bottom and respects the keyboard and safe areas. Primary controls are at least 44 px tall.

### Routes
```
/                      Overview
/tasks                 All tasks (?view=kanban|list plus filter params)
/tasks/[id]            Task detail (panel over /tasks on desktop, page on mobile)
/needs                 Needs Denny (?tab=answer|review)
/projects              Project index
/projects/[slug]       Project detail (?tab=tasks|settings)
/settings              Settings (?section=connections|workers|preferences|execution|notifications)
/login                 Sign-in
/setup                 First-use flow (only while setup is incomplete)
/api/mcp               MCP endpoint
/api/worker/*          Worker endpoints (Phase 2)
```

---

## 5. Data model (Supabase Postgres)

All tables have `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz default now()` with a trigger, unless noted. Owner-only access via row level security (section 12).

### 5.1 Enums
```sql
create type task_status   as enum ('inbox','ai_queue','in_progress','needs_denny','review','done');
create type next_owner    as enum ('denny','ai','none');
create type priority      as enum ('low','normal','high','urgent');
create type agent_kind    as enum ('claude_code','codex');
create type task_source   as enum ('platform','claude_code_vscode','claude_code_cli','codex_cli','chatgpt');
create type message_kind  as enum ('comment','instruction','answer','update','question','result','system');
create type author_kind   as enum ('denny','agent','system');
create type request_kind  as enum ('choice','text','asset','action');
create type request_state as enum ('open','resolved','withdrawn');
create type request_reason as enum ('decision_required','waiting_for_asset','authentication_required','access_required','retry_limit_reached','usage_limit_reached','other');
create type run_state     as enum ('queued','running','waiting_for_input','pausing','paused','stopping','completed','failed','cancelled','interrupted');
create type run_kind      as enum ('initial','continuation','changes','retry','instruction','external');
create type check_state   as enum ('passed','failed','not_run','unknown');
create type artifact_kind as enum ('preview','screenshot','pr','commit','document','change_summary');
create type worker_state  as enum ('online','busy','offline','needs_setup','auth_required');
create type integration_state as enum ('not_configured','connected','needs_auth','error','unavailable');
```

### 5.2 Tables

**projects**
| column | type | notes |
|---|---|---|
| slug | text unique | `restomart` |
| name | text | |
| purpose | text | one line |
| context | text | brief for agents |
| repo | text null | `owner/name`; null for non-code projects |
| base_branch | text null | |
| preview_url | text null | |
| reference_links | text[] | |
| worker_id | uuid null fk workers | |
| default_agent | agent_kind null | null = manual work |
| verification_commands | text[] | one command per item |
| retry_limit | int default 1 | 0 to 2 |
| time_limit_minutes | int default 30 | |
| pinned | bool default false | |
| archived | bool default false | |

**tasks**
| column | type | notes |
|---|---|---|
| number | int unique | from sequence; display ID is `TW-{number}` |
| project_id | uuid fk | |
| title | text | required |
| brief | text | |
| status | task_status default 'inbox' | |
| next_owner | next_owner | derived, see 6.3 |
| owner_override | next_owner null | only while in_progress |
| agent | agent_kind null | last or preferred agent |
| priority | priority default 'normal' | |
| due_date | date null | |
| source | task_source default 'platform' | provenance only |
| sort_order | double precision | manual order within a column |
| archived_at | timestamptz null | |
| cancelled_at | timestamptz null | |
| accepted_at | timestamptz null | set by Approve completion |
| brief_changed_during_run | bool default false | |
| last_viewed_at | timestamptz null | for "New" and "New result" markers |

**acceptance_criteria**
`task_id`, `position int`, `text`, `agent_state check_state default 'unknown'`, `agent_run_id uuid null`, `accepted bool default false`, `accepted_at`.

**messages**
`task_id`, `author author_kind`, `agent agent_kind null`, `kind message_kind`, `body text`, `run_id uuid null` (the run it belongs to or will be included in), `pending_for_next_run bool default false`, `delivered_run_id uuid null`, `client_id text unique null` (idempotency from the browser), `external_event_id text unique null` (idempotency from MCP).

**attachments**
`task_id`, `message_id null`, `request_id null`, `storage_path`, `file_name`, `size_bytes`, `mime`, `state text check in ('uploading','ready','error')`.

**input_requests**
`task_id`, `run_id null`, `kind request_kind`, `reason request_reason`, `question text`, `context text`, `blocks text` (what it blocks, human readable), `choices text[]`, `manual_choice_index int null` (choosing it means "Denny takes over"), `required bool default true`, `state request_state default 'open'`, `answer_text text null`, `answer_choice int null`, `answered_at`, `asked_by text` (Claude Code, Codex, System), `external_event_id text unique null`.

**runs**
`task_id`, `attempt int` (1, 2, 3 per task), `kind run_kind`, `agent agent_kind`, `worker_id uuid null` (null for external sessions), `external_session_id text null`, `state run_state`, `step int` (0 Reading project, 1 Editing files, 2 Running checks, 3 Preparing result), `step_label text`, `note text`, `brief_snapshot text`, `criteria_snapshot jsonb`, `instructions_snapshot jsonb`, `branch text null`, `worktree_path text null`, `queued_at`, `claimed_at`, `started_at`, `ended_at`, `last_heartbeat_at`, `lease_expires_at`, `error_summary text null`, `last_meaningful_step text null`, `partial_output text null`, `suggested_action text null`, `end_note text null`, `wait_reason text null`, `usage jsonb null` (only when reported; never estimated), `stop_requested_at`, `pause_requested_at`.

**run_events** (technical log, append only)
`run_id`, `at timestamptz`, `level text`, `text text`, `external_event_id text unique null`.

**checks**
`run_id`, `name`, `state check_state`, `source text check in ('agent','owner')`, `detail text null`.

**results** (one per run that submits)
`run_id unique`, `summary text`, `changes text[]`, `limitations text[]`.

**artifacts**
`run_id`, `kind artifact_kind`, `label text`, `url text null`, `storage_path text null`, `issue text null` (for example "Protected deployment"), `position int`.

**activity**
`task_id`, `run_id null`, `actor text`, `action text` (machine key), `text text` (human readable), `at timestamptz`.

**notifications**
`task_id`, `request_id null`, `run_id null`, `kind text check in ('input_requested','result_ready','failure_needs_action')`, `text`, `read_at timestamptz null`, `group_key text` (task plus kind; collapse unread duplicates).

**workers** (Phase 2, table exists in Phase 1)
`name`, `machine_label`, `state worker_state`, `supported_agents agent_kind[]`, `last_seen_at`, `token_hash text` (never return), `max_concurrent_runs int default 2`.

**integrations**
`key text unique` (`claude_code_mcp`, `codex_mcp`, `chatgpt`, `github_events`), `state integration_state`, `last_success_at`, `token_hash text null`.

**settings** (single row)
`timezone text default 'device'`, `setup_completed_at`, `setup_step int`.

### 5.3 Indexes and constraints
- `tasks(status, sort_order)`, `tasks(project_id)`, `runs(task_id, attempt)`, `runs(state)`, `input_requests(task_id) where state = 'open'`.
- Partial unique index: at most one active run per task: `unique (task_id) where state in ('queued','running','waiting_for_input','pausing','paused','stopping')`.
- One writer per project is enforced at claim time (section 9), not with a constraint.

---

## 6. State rules

### 6.1 Task status
Six fixed statuses, in this order on the board: Inbox, AI Queue, In Progress, Needs Denny, Review, Done. Archived and Cancelled are flags, not columns. Failed is a run state, not a column.

| From → To | Allowed? | Effect |
|---|---|---|
| any → AI Queue | Only if prerequisites pass (6.4) and no active run | Creates a `queued` run. Phase 1: AI Queue is allowed as a plain status but shows "No worker yet · tracking only". |
| any → In Progress | Yes, unless a run is executing | Never starts an agent. Toast: "Moved to In Progress. This doesn't start an agent." |
| any → Needs Denny | Yes | Owner Denny |
| any → Review | Only if the task has at least one result | Otherwise: "Review needs a submitted result. For work you did yourself, move it to Done." |
| Review → Done | Yes | Same as Approve completion |
| other → Done | Yes, unless a run is active | "Marked Done manually", logged |
| any → Inbox | Yes, unless a run is executing | A queued run is cancelled ("Removed from the queue"). A waiting run is cancelled and its open requests are withdrawn. |
| any move while a run is `running`, `pausing`, `paused` or `stopping` | No | "Stop the run before moving it." with an Open task action |
| any move while queued, except to Inbox | No | Explain and offer Open task |
| any move while waiting for input, except to Inbox | No | "Answer the open request to resume." |

Archive and Cancel are refused while a run is executing. Cancel removes a queued run and keeps all history.

### 6.2 Run states
```
queued → running → (waiting_for_input | completed | failed | interrupted)
running → pausing → paused → running
running|pausing|paused → stopping → cancelled
queued → cancelled
waiting_for_input → completed (ended for input; continuation queued as a new run)
running → interrupted (lease expired: no heartbeat past lease, or usage limit hit)
```
- `completed` from a normal run moves the task to Review, owner Denny, and creates a `result_ready` notification.
- `failed` with retries left and project rules allowing it: queue one `retry` run automatically. Otherwise move the task to Needs Denny with an input request, reason `retry_limit_reached`, choices including "Leave it, I'll take over manually" (`manual_choice_index`).
- `interrupted` keeps the task in In Progress with an attention item "Agent stalled" on Overview and Needs Denny. Actions: Retry as new run, or take over.
- Late events from an older run never overwrite the task status set by a newer run. They are stored in `run_events` and activity only.

### 6.3 Next owner (derived)
| Status | Next owner |
|---|---|
| Inbox | none |
| AI Queue | ai |
| In Progress | ai if a run is running, else denny (override allowed) |
| Needs Denny | denny |
| Review | denny |
| Done | none |

Store it on the row for filtering, recompute it on every status or run change.

### 6.4 Prerequisites for queueing (exact messages)
- No repository: "This project has no repository. Coding runs need one (Project settings › Repository)."
- Agent is Codex: "Codex can't execute work yet; its adapter is planned for a later stage. Switch the agent to Claude Code."
- No worker: "No worker is assigned to this project."
- Brief shorter than 20 characters: "The brief is too short to act on. Describe the outcome in a sentence or two."
- Active run exists: "Run N is already active on this task."

If any fail, nothing is queued. Show a dialog (canvas `S08`) listing them with "Open project settings" and "Open task".

### 6.5 Waiting reasons (concrete, never a confidence score)
Decision required · Waiting for asset · Authentication required · Access required · Worker offline (with last seen) · Project busy (queued behind TW-N) · Retry limit reached · Usage limit reached (resets at HH:MM) · Agent stalled.

---

## 7. Core flows

### 7.1 Create a task (`S06`, `S07`, `M11`)
Fields: Title (required), Project, Outcome and brief, Acceptance criteria (one per line, optional), Reference link (optional), Attach files. "More options" collapsed: Priority, Due date.
Execution summary box: project, repository and branch, agent (Claude Code), worker and its state, scope sentence ("Inspect the repository, edit an isolated branch, run approved checks, prepare a reviewable change. No merge, deploy or client messages."). Missing prerequisites listed inline; Run with AI disabled when any are missing. Worker offline is a warning, not a blocker.
Buttons: Save to Inbox (never starts work), Run with AI. Ctrl/Cmd+Enter saves to Inbox. Open the new task afterwards.

### 7.2 Comment vs instruction vs answer (composer)
Explicit modes as a segmented control above the text area: Comment, Send to AI, Answer and Resume (only when an open request exists). The primary button label always states the effect: "Comment", "Send to AI", "Save for next run", "Answer and Resume". A help line under the field explains the effect in one sentence. Enter = newline, Ctrl/Cmd+Enter = submit. Drafts persist per task in localStorage. Attachments show Uploading, Ready, Upload failed (Retry, Remove).
- Comment never queues anything.
- Send to AI with no active run: saves the instruction and queues a run if prerequisites pass. With an active run: saves it with `pending_for_next_run = true` and shows "Pending: saved for the next run. The running agent hasn't received it." When the next run starts, mark it delivered: "Included in run N".
- Offline browser: message is stored locally as "Not sent" with Retry send. Never claim it was sent.

### 7.3 Answer and Resume (`T01`, `T02`, `T03`, `M05`, `M06`, `M07`)
Open requests render above the tabs as prominent cards: tag ("Needs your answer · 1 of 2"), reason chip, age and asker, question, context, "Blocks: …", input by kind (radio choices, text, attach file, or "I've done this" checkbox), optional note, validation adjacent to the field.
Submit:
1. Validate (choice or text required; asset needs file or text; action needs the confirmation).
2. Resolve the request, add an Answer message, mark related notifications read.
3. If other required requests are open: "Answer saved. 1 more request still blocks this task: …" Task stays in Needs Denny.
4. If all resolved and the chosen option is the manual takeover choice: task to In Progress, owner Denny, no run.
5. Phase 1: task to In Progress, next owner ai, and the answer is returned to the reporting session through `get_task` / `wait_for_answer` (section 8).
6. Phase 2: end the waiting run as `completed` with end note "Ended at an input request. Work continues in the next run with your answer." Queue a `continuation` run. If the worker is offline: "Answer saved. Work will resume when the worker is online."
Never auto-select an option. Never treat time passing as an answer.

### 7.4 Review (`T08`, `T09`, `T10`, `M08`)
Results tab shows the latest result first: run label, agent, time, summary, What changed, Evidence (artifact tiles; preview, screenshot, PR, commit, document), Checks (each with Agent-reported or Owner check), Known limitations. An inaccessible artifact shows its issue inline and other evidence stays usable.
Review bar (only in Review with no active run): Approve completion (primary), Request changes. Fixed note: "Approving accepts the task outcome and moves it to Done. It doesn't merge PR #N or deploy anything. Merge and deploy are separate actions that need their own permissions and aren't enabled for this project."
Request changes: required text, at least 12 characters, error "Describe what should change so the agent can act on it, for example a size, a section or a behavior." Creates an instruction message and a `changes` run. The previous result stays in history.
Never infer Passed from an agent saying it is done. Checks come only from explicit check records.

### 7.5 Failure and recovery (`T11`, `T12`)
Run card shows: error summary, last meaningful step, partial output, suggested next action, technical log (collapsed). Banner actions: Retry as new run (disabled while another run is active), Fix connection (opens the relevant settings section) when the error is authentication related, Run details.

### 7.6 Pause and Stop (`T04`)
- Stop: run → `stopping` ("Stop requested. Waiting for Denny-PC to confirm. Stop doesn't revert files.") → `cancelled` when the worker acknowledges. Task to In Progress, owner Denny, partial work kept on the branch. End note names the step it stopped in.
- Pause: only if the spike proves a safe stop point between steps. Otherwise render the Pause button disabled with tooltip text "Pause isn't supported by this agent yet. Stop is available."

---

## 8. MCP reporting server (Phase 1 core)

Endpoint `/api/mcp`, MCP over streamable HTTP. Auth: `Authorization: Bearer <token>`; token generated in Settings › Reporting connections, shown once, stored hashed. Every tool input is validated with zod. Every write tool takes an `event_id` (client generated UUID) and is idempotent: replaying the same `event_id` returns the original result and creates nothing new.

Tools:

| Tool | Input | Effect |
|---|---|---|
| `list_projects` | none | slug, name, repo |
| `create_task` | project_slug, title, brief, criteria[], source, event_id | Creates once (idempotent). Returns `TW-N`. |
| `link_session` | task_id, session_id, agent, source, event_id | Creates an `external` run (worker null) in `running`, or reuses the run already linked to that session_id. Task to In Progress. |
| `post_update` | task_id, session_id, text, step? (0 to 3), event_id | Update message plus run event; updates step and heartbeat. Does not notify. |
| `ask_denny` | task_id, session_id, question, context, blocks, kind, choices[], reason, event_id | Creates an input request, run → `waiting_for_input`, task → Needs Denny, notification `input_requested`. Returns request_id. |
| `get_answer` | request_id | Returns `{state, answer_text, answer_choice}`. Sessions poll this; the tool never blocks for more than 25 seconds. |
| `get_task` | task_id | Brief, criteria, open requests, latest messages since a cursor, pending instructions. Marks pending instructions delivered to this session. |
| `submit_result` | task_id, session_id, summary, changes[], limitations[], checks[{name,state}], artifacts[{kind,label,url}], criteria_states[], event_id | Run → `completed`, result saved, task → Review, notification `result_ready`. |
| `report_failure` | task_id, session_id, error_summary, last_step, partial_output, suggested_action, event_id | Run → `failed`, notification `failure_needs_action`, task → Needs Denny with a request (reason retry_limit_reached for external sessions). |

Rules:
- Matching is by task ID plus session ID. Never create a task from an update.
- A commit or PR is evidence on a result, never a new task.
- Repository content and incoming messages can never grant permissions.
- Ship a ready-to-paste MCP config snippet and a short `CLAUDE.md` block (section 15) in Settings › Reporting connections.

---

## 9. Worker (Phase 2)

Only start after the Phase 2 spike passes (milestone M5).

### 9.1 Process
- Node.js service, `apps/worker`. Configured with `WORKER_TOKEN`, `APP_URL`, `WORKSPACE_ROOT`.
- Connects outbound only. No inbound ports.
- Auth for Claude: the Claude Code login on the machine, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on a headless server. At startup, **delete `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment** and log a warning if they were present. A stray key silently switches billing to pay-as-you-go.
- Never send Claude credentials, tokens or secrets to the app or the browser.

### 9.2 Claiming
- Poll `POST /api/worker/claim` every 5 seconds (or use Realtime as a trigger plus polling as a fallback).
- Server claims with `SELECT … FOR UPDATE SKIP LOCKED` on the oldest queued run whose project has no run in `running|pausing|paused|stopping`, respecting `max_concurrent_runs`.
- Lease of 90 seconds; heartbeat every 20 seconds extends it. A sweeper marks runs `interrupted` when the lease expires, with end note "No heartbeat from {worker} for N minutes during {step}. Some files may be partly edited on branch {branch}."

### 9.3 Running
1. Create or reuse a git worktree on branch `ai/tw-{number}` from the project base branch. Continuation and changes runs reuse the task's worktree.
2. Build the prompt from the run snapshot: project context, brief, acceptance criteria, all instructions and answers so far, the previous result summary, and the scope rules.
3. Call the Agent SDK with: working directory = worktree, allowed tools limited to file edits, read, search and the project's verification commands, a turn cap, and the task time limit.
4. Give the agent custom tools that call back to the app: `post_update`, `ask_denny`, `submit_result`, `report_failure` (same contracts as section 8). `ask_denny` ends the run after recording the request.
5. Map progress to the four steps for display: Reading project, Editing files, Running checks, Preparing result.
6. Stop: abort the SDK call, acknowledge, set `cancelled`. Files are not reverted.
7. Usage limit error from the SDK: set the run `interrupted`, wait reason "Usage limit reached · resets at HH:MM" (use the reset time if the error provides one, otherwise "later"), hold that worker's queue, notify once.
8. Record `usage` only if the SDK reports it. Otherwise display "Not available".

### 9.4 Permissions (enforced in the worker and the server, not only in the UI)
Allowed: inspect repository, edit the isolated branch, run approved verification commands, produce artifacts, push the branch and open a draft PR.
Forbidden unless separately authorised in a future version: merge, production deploy, destructive data operations, external messages, spending.

---

## 10. Screens

Each screen below lists its canvas frames. Build every one. Phase markers show what can be stubbed.

### 10.1 Overview (`D01`, `D02`, `D03`, `M02`)
Main column: Needs your attention (rows: reason chip, title, question preview, ID and project, request count, age, Answer or Open), Ready for review (rows with check summary and Review), Running now (run state, step and worker, last update). Side column: Queue summary with each queued task's waiting reason, offline worker warnings only when relevant, Recent activity (7 items). Empty attention state: "Nothing needs you right now. N running, N queued." No charts, scores or stat cards.

### 10.2 All tasks · Kanban (`D04`, `M04`)
Six columns in lifecycle order with count and empty text. Card: ID, project, priority only if High or Urgent, New or New result tag, title (multi-line, wraps), question preview box when a request is open ("Question" or "2 questions"), secondary state line (see below), "Next: owner", agent label, Move menu (⋯) listing all six statuses with the current one disabled.
Secondary state priority: queued wait reason → running step "(step N of 4)" → waiting for answer → interrupted with last heartbeat time → failed retry limit → review check summary ("Checks: 1 failed, 2 passed, 1 not run") → accepted time → "Manual task".
Drag between columns with dnd-kit (pointer and keyboard sensors). Invalid moves snap back and show the reason. A failed save restores the card and shows a Retry action. Manual order within columns; newly queued cards go last.

### 10.3 All tasks · List (`D05`, `D06`, `M03`)
Columns: Title (with ID and secondary line), Project, Status (inline select, same rules as moves), Next owner, Agent, Priority, Updated (relative; absolute on hover). Sort by any column. Group by status, project or none. Same filter bar as Kanban.

### 10.4 Filters (shared)
Text filter, Project, Next owner, Agent (Claude Code, Codex, manual), Priority, Status, Show archived and cancelled, Clear filters (only when any filter is active), result count "N of M tasks". Persist view and filters in the URL and localStorage. Empty result (`D07`): "No tasks match these filters" with Clear filters.

### 10.5 Needs Denny (`D08`, `D09`, `M01`, `M10`)
Tabs: Answer needed (count), Review needed (count). One card per task with: reason chip, priority if High or Urgent, project, ID, request count if more than one, due date, the question as the heading, task title, "Blocks: …", "Waiting {age}", primary action Answer (or Open for stalled runs, Review result in the review tab). Order: priority, then due date, then oldest waiting. Includes interrupted runs as "Agent stalled". Empty: "Nothing needs you right now" plus running and queued counts.

### 10.6 Task detail (`T01` to `T18`, `M05` to `M09`)
Header: back or close, ID, "Source: …" chip (provenance, not a connection), archived or cancelled chip, Open as page, Copy link, More (Archive, Cancel task). Editable title. Field row: Status, Project (locked while a run is active), Priority, Next owner, Agent (Codex option disabled "not available yet", None for manual), Due.
Body order:
1. Run banner when relevant: queued (wait reason, Remove from queue), running (step chips, last update, Pause, Stop), pausing, paused (Resume, Stop), stopping, waiting for input, interrupted (Retry as new run, Run details), failed (Retry, Fix connection, Run details), stopped (Start a new run).
2. Open request cards (7.3).
3. Tabs: Conversation (count), Results (run count), Activity.

Conversation tab: Brief (Edit; when edited during a run, show "Brief edited after run N started at HH:MM. Run N keeps the snapshot from then; your edits apply to the next run."), Acceptance criteria (each row: text, "Agent: Passed/Failed/Not run/Unknown" chip, "Accepted by Denny" checkbox, add criterion field), message list (avatar, author, type tag, relative time with absolute on hover, body with preserved line breaks, attachments, pending or delivered or Not sent markers), composer.
Results tab: latest result (7.4), review bar, "Outcome accepted …" note when Done, run history newest first (each expandable: state, attempt, kind, agent, worker or "External session", started, duration, last update, usage, step chips, error block, end note, checks, technical log).
Activity tab: newest first, actor, text, relative and absolute time.
Long titles and multi-paragraph briefs must wrap cleanly. Indonesian text is supported everywhere.

### 10.7 Projects (`P00`, `P-*-Tasks`, `P-*-Settings`, `M12`)
Index cards: name, purpose, need attention count, active count, done count, worker line ("Denny-PC · online", "No worker · manual work only"), repository line.
Project detail header: purpose, repository, base branch, preview URL, worker state. Tabs Tasks and Settings.
Tasks tab: compact table (title with secondary line, status badge, next owner, agent, priority, updated). Empty: "No tasks in this project yet."
Settings tab: context, repository (optional for non-code work), base branch, preview URL, worker, default agent (Claude Code, Codex disabled, None). Execution mode: Manual (selected), Auto-run eligible tasks (disabled with reason). Allowed actions: the four default permissions checked and locked; merge, deploy, destructive changes, client messages and spending unchecked and disabled with "Needs separate authorization". Advanced (collapsed): verification commands, automatic retries (0 to 2), run time limit. Autosave with a saved indicator. A project with no repository shows the manual-work notice.

### 10.8 Settings (`S01` to `S05`, `M13`)
- Reporting connections: Claude Code reporting (MCP) with generate or revoke token, config snippet, last successful event time; Codex reporting (MCP) same mechanism, labelled as reporting only; ChatGPT connection "Not configured"; GitHub events "Unavailable · later". States: Not configured, Connected, Needs authentication, Error, Unavailable. Never display a token after creation.
- Workers and agents: worker list (name, machine label, supported agents, last seen, active run, state), register worker (shows a one-time token and the start command), revoke. Providers: Claude Code "Available" once a worker reports it, Codex "Not available yet". Phase 1 shows "No worker registered · tracking only".
- Preferences: timezone (device default plus override list), interface language English (Indonesian content supported).
- Execution defaults: read-only summary of the locked rules (manual execution, review required, one writer per project, no confidence routing).
- Notifications: in-app only. Push, email, Telegram, WhatsApp disabled "Later".

### 10.9 Dialogs and global states
- New task (`S06`, `S07`), Queue blocked (`S08`), Preview viewer (opens preview URLs in a new tab; screenshots in a lightbox).
- Notifications popover (`D02`): kind, text, time, read state, Mark all read. Clicking opens the exact task and request and marks that notification read. Reading never resolves anything.
- Search (`D03`): titles, IDs, briefs, project names; up to 7 results; Esc clears.
- Offline (`D10`): banner "You're offline. Drafts stay here. Anything you send is marked Not sent until you reconnect."
- Toasts: one at a time, `aria-live="polite"`, optional action (Retry, Open task), auto-dismiss after 6 seconds (9 with an action).
- Loading: skeletons that match the final layout. No spinners over whole pages, no endless animations.

### 10.10 First use (`S09` to `S14`)
Sign-in (magic link to the single allowed email), then: create project, add context, connect reporting (skippable), register worker (skippable), create first task. Progress bar only while incomplete. Board usable without any execution setup.

---

## 11. Design system

Use these exact tokens. Map them into Tailwind theme and shadcn CSS variables.

### 11.1 Type
Inter (400, 500, 600, 700) with system-ui fallback. Base 14 px. Scale: 11.5 labels, 12.5 secondary, 13.5 body dense, 14 body, 15 section heading and question card, 20 task title (18 on mobile). Line height 1.45 to 1.6 for text blocks.

### 11.2 Color
| Token | Value |
|---|---|
| Background | `#F7F7F8` |
| Surface | `#FFFFFF` |
| Sidebar | `#FBFBFC` |
| Border | `#E4E4E7` |
| Border strong | `#D4D4D8` |
| Text | `#18181B` |
| Text secondary | `#3F3F46` |
| Text muted | `#52525B` (minimum for small text) |
| Accent | `#4F5BD5` (hover `#3F4BC0`, tint `#ECEDF8`, on-tint text `#2D379A`) |
| Danger | `#B42318` (tint `#FDECEC`) |
| Warning text | `#8F4200` (tint `#FFF0DD`, soft `#FFF8EE`, border `#F1DDBF`) |
| Success | `#1A6A37` (tint `#E5F5EA`) |

Status badges (background / text, plus a distinct shape so color is never the only cue):
| Status | Colors | Shape |
|---|---|---|
| Inbox | `#F1F1F3` / `#45454F` | dashed ring |
| AI Queue | `#EDF1F7` / `#3B4F6B` | ring with a tick |
| In Progress | `#E7F0FD` / `#1B56AD` | half-filled circle |
| Needs Denny | `#FFF0DD` / `#8F4200` | filled diamond |
| Review | `#F0EBFC` / `#5B32B8` | ring with a dot |
| Done | `#E5F5EA` / `#1A6A37` | filled circle with a check |

Run states, checks (✓ Passed, × Failed, – Not run, ? Unknown) and reason chips follow the component sheet on the canvas.

### 11.3 Spacing and shape
4/8 px scale. Radius: 6 inputs and badges, 8 cards and buttons, 10 to 12 panels and blocks, 14 dialogs. Shadows only on floating layers (menus, panel, dialogs, toasts). Buttons 34 px desktop, 28 px small, 44 px primary on mobile.

### 11.4 Rules
Light theme only. One accent. No gradients, illustrations, mascots or glowing AI panels. AI identity is a small provider label with a terminal glyph. No progress percentages; use step labels.

### 11.5 Components to build (shadcn-based)
StatusBadge, RunStateBadge, CheckChip, ReasonChip, PriorityTag, ProviderLabel, TaskCard, TaskRow, MoveMenu, FilterBar, ViewToggle, AttentionRow, NeedsCard, InputRequestCard, RunBanner, StepChips, Message, Composer (with modes and attachment chips), ResultPanel, ArtifactTile, CheckList, ReviewBar, RunHistoryItem, TechLog, ActivityList, ProjectCard, IntegrationRow, WorkerRow, EmptyState, Skeletons, Toast, OfflineBanner, NotificationPopover, SearchPopover, NewTaskDialog, PrereqDialog.

---

## 12. Security

- Single allowed email in an env var. Every table has RLS: `auth.uid() = owner_id` (add `owner_id` to all tables, default from the session).
- Service role key only on the server. MCP and worker endpoints use their own hashed bearer tokens with scopes (`report` for MCP, `worker` for the worker).
- Secrets are never returned to the client after creation. Redact tokens and env values from run logs before storing.
- Webhooks (later) require signature verification.
- Permissions are enforced on the server and in the worker. UI toggles are display only.

---

## 13. Quality bar

- WCAG 2.2 AA: contrast, visible focus, labelled fields, semantic buttons and links, accessible dialogs with focus trap and return, keyboard Move menu for every card, `prefers-reduced-motion` respected, status changes announced politely without stealing focus, nothing required that depends on hover.
- Timestamps: relative in lists, absolute on hover and in details, rendered in the selected timezone.
- Idempotency: browser writes carry a `client_id`; MCP and worker writes carry an `event_id`. Duplicate delivery changes nothing.
- Realtime: on reconnect, refetch the open views; never trust a missed event.
- Tests:
  - Unit: status transition rules, next owner derivation, prerequisite checks, claim selection, idempotent tool handlers.
  - Playwright: (1) create a task and save to Inbox, (2) comment does not create a run, (3) MCP ask_denny creates a request and it appears on Overview and Needs Denny, (4) answer on a 390 px viewport resolves it, (5) submit_result moves the task to Review, (6) request changes then approve, (7) invalid drag shows a reason and restores the card, (8) filter empty state.
- No horizontal overflow at 390 px on any screen.

---

## 14. Build order

| Milestone | Scope | Done when |
|---|---|---|
| M0 Setup | Next.js app, Tailwind, shadcn, Supabase project, auth with single email, CI with typecheck, lint and tests, seed script with the canvas mock data | Denny can sign in; `pnpm seed` loads sample tasks |
| M1 Data and core screens | Schema and RLS, Overview, All tasks Kanban and List, filters, task detail (Conversation, Activity), New task, projects index and detail with settings | Tasks can be created, edited, moved with drag and menu, and filtered; transition rules enforced |
| M2 Requests and results | Input requests UI and answering, results and evidence, checks, review bar, approve, request changes, run history (data entered manually or by seed) | Every `T` frame renders from real data |
| M3 MCP reporting | `/api/mcp` with all section 8 tools, token management in Settings, notifications, Realtime | A real Claude Code session links a task, asks a question, Denny answers on his phone, the session reads the answer and submits a result |
| M4 Mobile and polish | Mobile layouts and tab bar, offline handling, drafts, skeletons, accessibility pass, Playwright suite green | All `M` frames match; tests pass at 390 px |
| M5 Worker spike (2 days, hard stop) | Standalone script: claim one queued run, Agent SDK in a worktree, custom tools `ask_denny` and `submit_result`, Stop | One task goes queued → question → answered → continuation → result with no terminal open. If not working after 2 days, stop and keep Phase 1 |
| M6 Worker | Section 9 in full: leases, heartbeats, sweeper, retries, usage-limit handling, worker settings UI | Queue, offline worker, project busy and interrupted states all behave as on the canvas |

Phase 1 is M0 to M4. Phase 2 is M5 and M6.

---

## 15. Snippet for Denny's repositories (Phase 1)

Add this to each project's `CLAUDE.md` once reporting is set up:

```md
## Task Workspace reporting
This repo reports to Task Workspace through the `task-workspace` MCP server.
- At the start of work on a task, call `link_session` with the task ID (for example TW-142). If no task exists, ask Denny before calling `create_task`.
- Post a short `post_update` when you move between reading, editing, checking and preparing the result.
- If you need a decision, asset, access or a manual action from Denny, call `ask_denny` with a clear question, why it matters, what it blocks, and choices when useful. Then poll `get_answer` and do not guess.
- When finished, call `submit_result` with a summary, changes, limitations, explicit checks (Passed, Failed, Not run, Unknown) and links to the preview, screenshots, PR or commit. Never report a check as Passed unless you ran it.
- Never merge, deploy, change production data or message clients.
```

---

## 16. Copy rules

- Plain, direct English. Short sentences. No hype, no "AI magic", no exclamation marks.
- Every button says what happens: "Save to Inbox", "Answer and Resume", "Save for next run", "Retry as new run", "Request changes and queue run".
- Every disabled control explains why in one line.
- Never imply a connection exists when it does not. Source labels are provenance.
- Use the exact messages given in sections 6 and 7.

---

## 17. Open items (decide during the build, log in DECISIONS.md)

1. Does the Agent SDK expose a safe pause point? Decide in M5. Default: Pause disabled.
2. Exact usage-limit error shape and reset time from the SDK. Decide in M5.
3. Preview deployments behind Vercel protection: use share links or rely on screenshots. Default: show the issue inline and keep screenshots.
4. Worker location (PC or VPS). Default: PC first.
5. Measure in M5 how much of the 5-hour window a typical task uses, and record it. This sets how many runs per day are realistic.
