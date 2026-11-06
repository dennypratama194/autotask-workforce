# Decisions

Choices the PRD does not cover. Newest last.

## M0

1. **PRD location.** `docs/PRD.md` did not exist. Copied from `~/Desktop/TASK_WORKSPACE_PRD.md` unchanged.
2. **Schema ships in M0.** The PRD puts the schema in M1, but `pnpm seed` needs tables. The full section 5 schema and RLS are in `supabase/migrations/0001_schema.sql`. M1 builds on it.
3. **Inter font.** The global standards ban Inter as a display font. PRD 11.1 specifies Inter, and the PRD wins here.
4. **Tailwind v4, tokens in CSS.** Tokens live as CSS custom properties in `src/app/globals.css` and map into the Tailwind theme (`@theme inline`) and shadcn variables. No `tailwind.config`. The type scale sizes are named `text-label|sub|dense|base|section|title` (`sub`, not `secondary`, to avoid clashing with the `secondary` color).
5. **Next.js 16 `proxy.ts`.** Next 16 renamed `middleware.ts` to `proxy.ts`. Auth gating lives in `src/proxy.ts`.
6. **Single-email auth.** The magic-link request is refused server-side for any address other than `ALLOWED_EMAIL`, with the same response either way so the address is not revealed. The callback and proxy also sign out any session whose email differs. `shouldCreateUser: true` so the first sign-in creates the account; the allowed-email check is what limits access.
7. **Seed creates the owner user.** `pnpm seed` creates the `ALLOWED_EMAIL` auth user (pre-confirmed) if it does not exist, because every row needs `owner_id`. Seed is re-runnable: it deletes the owner's projects, tasks and workers first. It is not shipped as live data.
8. **Seed data is invented.** The canvas is not readable from the repo, so the seed uses 3 projects and 7 tasks covering every status, an open request, a result with mixed checks, and one queued run with worker offline. Replace later if the canvas data matters.
9. **Pinned versions.** ESLint 9 (eslint-config-next peers do not support 10 yet) and TypeScript 5.9 (7.x is the native port and not yet safe with Next tooling).
10. **shadcn components added on demand.** `components.json`, `cn` and `Button` exist; further components are added in M1 when screens need them.
11. **pnpm.** Not installed on this machine; installed globally with `npm i -g pnpm@9`.
12. **Task numbers.** Come from `task_number_seq` starting at 1, so seeded tasks are TW-1 to TW-7.

## M1 to M6

13. **Data flow.** Client screens read `/api/snapshot` and `/api/tasks/[n]` through TanStack Query. Realtime only invalidates those queries, so a reconnect always refetches.
14. **Shared engine.** Server actions, MCP tools and worker endpoints all call `src/lib/server/engine.ts`, so the rules are enforced server-side in one place.
15. **MCP is hand-written JSON-RPC.** Stateless streamable HTTP with JSON responses (`src/lib/server/mcp.ts`), which is all the tools need. GET returns 405, as the spec allows.
16. **Idempotency ledger.** Added `mcp_events` (event_id, stored result). A failed call releases its event_id so a retry works.
17. **Schema additions.** `tasks.reference_url`, `workers.held_until`, `workers.hold_reason`, `claim_run()`, an `attachments` bucket. See `0002_runtime.sql`.
18. **Fake database for tests.** `E2E_FAKE_DB=1` swaps in an in-memory database and skips auth so Playwright runs without Supabase. Disabled whenever `NODE_ENV=production`. It does not prove RLS or Postgres behaviour.
19. **Task panel background.** `/tasks/[id]` always shows All tasks behind the panel, even when opened from Overview. Close returns to the previous page.
20. **Lease sweeper is lazy.** It runs on snapshot reads and worker polls. Vercel cron is not needed for one user.
21. **External runs.** Stop only marks the run stopped here; the app can't control a session it didn't start. The message says so.
22. **Changes without a worker.** Request changes saves a pending instruction, moves the task to In Progress and delivers it through `get_task`, since no `changes` run can execute.
23. **Instructions during a linked session.** `get_task` marks pending instructions delivered only if a run is active.
24. **New task attachments.** The dialog has no file field: a task must exist before files can be stored against it. Attach from the composer right after saving. Differs from PRD 7.1.
25. **Pause.** Shipped disabled by default (PRD 17.1). The SDK spike has not been run.
26. **Usage limit.** Read from the SDK's `rate_limit_event` (`status: rejected`, `resetsAt`) per its 0.3.318 types. If no reset time is given, the queue holds for 1 hour. Not yet observed against a real limit.
27. **Worker pushes, agent doesn't.** The agent gets file tools, read-only and commit git commands, and the verification commands, under `permissionMode: "dontAsk"`. The worker pushes and opens the draft PR after `submit_result`.
28. **Worker repos** clone from `https://github.com/{repo}.git` using the machine's git credentials.
29. **`pnpm seed` refuses to run when tasks exist** unless given `--reset`, because it deletes them.
30. **One commit.** M1 to M6 landed together rather than per milestone as PRD section 0 asks.
31. **Hosting.** Vercel project `task-workspace`, served at `task-workspace-nine.vercel.app`, functions in `sin1` to sit next to the Supabase database in `ap-southeast-1`.
