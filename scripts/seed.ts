import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.local" });
config();

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const url = need("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = need("SUPABASE_SERVICE_ROLE_KEY");
const allowedEmail = need("ALLOWED_EMAIL").trim().toLowerCase();

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function ensureOwner(): Promise<string> {
  const { data, error } = await db.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const existing = data.users.find((u) => u.email?.toLowerCase() === allowedEmail);
  if (existing) return existing.id;
  const created = await db.auth.admin.createUser({ email: allowedEmail, email_confirm: true });
  if (created.error || !created.data.user) throw created.error ?? new Error("createUser failed");
  return created.data.user.id;
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, label: string): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as NonNullable<T>;
}

async function main() {
  const owner_id = await ensureOwner();
  const o = { owner_id };

  const existing = await must(db.from("tasks").select("id").eq("owner_id", owner_id).limit(1), "check tasks");
  if (existing.length && !process.argv.includes("--reset")) {
    console.error("Tasks already exist. Seeding deletes all tasks, projects and workers. Re-run with: pnpm seed --reset");
    process.exit(1);
  }

  // Reset sample data. Tasks cascade to messages, requests, runs and everything under them.
  await must(db.from("tasks").delete().eq("owner_id", owner_id), "clear tasks");
  await must(db.from("projects").delete().eq("owner_id", owner_id), "clear projects");
  await must(db.from("workers").delete().eq("owner_id", owner_id), "clear workers");

  const [worker] = await must(
    db
      .from("workers")
      .insert({ ...o, name: "Denny-PC", machine_label: "Windows 11 · WSL2", state: "offline", supported_agents: ["claude_code"], last_seen_at: ago(95) })
      .select("id"),
    "workers",
  );

  const projects = await must(
    db
      .from("projects")
      .insert([
        {
          ...o,
          slug: "restomart",
          name: "Restomart",
          purpose: "Online ordering site for a restaurant supplier.",
          context: "Next.js storefront. Keep existing copy and structure unless a task says otherwise.",
          repo: "denny/restomart",
          base_branch: "main",
          preview_url: "https://restomart-preview.example.com",
          worker_id: worker!.id,
          default_agent: "claude_code",
          verification_commands: ["pnpm typecheck", "pnpm lint", "pnpm test"],
          pinned: true,
        },
        {
          ...o,
          slug: "portfolio",
          name: "Portfolio",
          purpose: "Personal portfolio site.",
          context: "Astro site. Motion with GSAP.",
          repo: "denny/portfolio",
          base_branch: "main",
          default_agent: "claude_code",
          verification_commands: ["pnpm build"],
          pinned: true,
        },
        {
          ...o,
          slug: "admin-notes",
          name: "Admin notes",
          purpose: "Non-code personal admin tasks.",
          context: "Manual work. No repository.",
          default_agent: null,
        },
      ])
      .select("id, slug"),
    "projects",
  );
  const pid = Object.fromEntries(projects.map((p) => [p.slug, p.id])) as Record<string, string>;

  const tasks = await must(
    db
      .from("tasks")
      .insert([
        { ...o, project_id: pid.restomart, title: "Add order history page", brief: "Customers should see their past orders with status and total, newest first.", status: "inbox", next_owner: "none", priority: "normal", agent: "claude_code", sort_order: 1 },
        { ...o, project_id: pid.restomart, title: "Fix cart total rounding on mobile", brief: "Totals show one cent off when quantity is above 9. Reproduce at 390px and fix.", status: "ai_queue", next_owner: "ai", priority: "high", agent: "claude_code", sort_order: 1 },
        { ...o, project_id: pid.portfolio, title: "Tighten hero animation timing", brief: "The hero reveal delays content too long. Cut the total sequence under one second.", status: "in_progress", next_owner: "ai", priority: "normal", agent: "claude_code", source: "claude_code_vscode", sort_order: 1 },
        { ...o, project_id: pid.restomart, title: "Choose payment provider for checkout", brief: "Checkout needs a provider decision before integration can start.", status: "needs_denny", next_owner: "denny", priority: "urgent", agent: "claude_code", due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), sort_order: 1 },
        { ...o, project_id: pid.portfolio, title: "Add case study page template", brief: "Create a reusable case study template with hero, problem, process and outcome sections.", status: "review", next_owner: "denny", priority: "normal", agent: "claude_code", sort_order: 1 },
        { ...o, project_id: pid.portfolio, title: "Compress project images", brief: "Convert gallery images to webp and keep visual quality.", status: "done", next_owner: "none", priority: "low", agent: "claude_code", accepted_at: ago(2880), sort_order: 1 },
        { ...o, project_id: pid["admin-notes"], title: "Renew domain and hosting", brief: "Check renewal dates and pay before they lapse.", status: "in_progress", next_owner: "denny", priority: "normal", agent: null, sort_order: 2 },
      ])
      .select("id, title"),
    "tasks",
  );
  const tid = Object.fromEntries(tasks.map((t) => [t.title, t.id])) as Record<string, string>;

  // Criteria
  await must(
    db.from("acceptance_criteria").insert([
      { ...o, task_id: tid["Fix cart total rounding on mobile"]!, position: 0, text: "Totals are correct for quantities 1 to 99" },
      { ...o, task_id: tid["Fix cart total rounding on mobile"]!, position: 1, text: "No horizontal overflow at 390px" },
      { ...o, task_id: tid["Add case study page template"]!, position: 0, text: "Template renders hero, problem, process and outcome", agent_state: "passed" },
      { ...o, task_id: tid["Add case study page template"]!, position: 1, text: "Layout holds at 390px", agent_state: "failed" },
    ]),
    "criteria",
  );

  // Runs
  const runs = await must(
    db
      .from("runs")
      .insert([
        { ...o, task_id: tid["Fix cart total rounding on mobile"]!, attempt: 1, kind: "initial", agent: "claude_code", worker_id: worker!.id, state: "queued", wait_reason: "Worker offline · last seen 1h 35m ago", queued_at: ago(30) },
        { ...o, task_id: tid["Tighten hero animation timing"]!, attempt: 1, kind: "external", agent: "claude_code", external_session_id: "seed-session-1", state: "running", step: 1, step_label: "Editing files", note: "Shortening stagger on the headline reveal.", started_at: ago(12), last_heartbeat_at: ago(1) },
        { ...o, task_id: tid["Choose payment provider for checkout"]!, attempt: 1, kind: "external", agent: "claude_code", external_session_id: "seed-session-2", state: "waiting_for_input", step: 0, started_at: ago(50), last_heartbeat_at: ago(45) },
        { ...o, task_id: tid["Add case study page template"]!, attempt: 1, kind: "external", agent: "claude_code", external_session_id: "seed-session-3", state: "completed", step: 3, started_at: ago(300), ended_at: ago(240), end_note: "Result submitted." },
        { ...o, task_id: tid["Compress project images"]!, attempt: 1, kind: "external", agent: "claude_code", external_session_id: "seed-session-4", state: "completed", step: 3, started_at: ago(3000), ended_at: ago(2950), end_note: "Result submitted." },
      ])
      .select("id, task_id, state"),
    "runs",
  );
  const runFor = (title: string) => runs.find((r) => r.task_id === tid[title])!.id;

  // Open request
  await must(
    db.from("input_requests").insert({
      ...o,
      task_id: tid["Choose payment provider for checkout"]!,
      run_id: runFor("Choose payment provider for checkout"),
      kind: "choice",
      reason: "decision_required",
      question: "Which payment provider should checkout use?",
      context: "Restomart sells to businesses in Indonesia. Both options support IDR; fees and payout times differ.",
      blocks: "Checkout integration and the order confirmation email",
      choices: ["Midtrans", "Xendit", "Leave it, I'll take over manually"],
      manual_choice_index: 2,
      asked_by: "Claude Code",
    }),
    "input_requests",
  );

  // Result, checks, artifacts for the review task and the done task
  const reviewRun = runFor("Add case study page template");
  await must(
    db.from("results").insert([
      { ...o, run_id: reviewRun, summary: "Added a case study template with four sections and wired it to the portfolio content collection.", changes: ["New CaseStudyLayout component", "Content collection schema for case studies", "Sample case study entry"], limitations: ["Mobile layout of the process section needs a second pass"] },
      { ...o, run_id: runFor("Compress project images"), summary: "Converted 14 gallery images to webp.", changes: ["14 images converted"], limitations: [] },
    ]),
    "results",
  );
  await must(
    db.from("checks").insert([
      { ...o, run_id: reviewRun, name: "Build", state: "passed", source: "agent" },
      { ...o, run_id: reviewRun, name: "Lint", state: "passed", source: "agent" },
      { ...o, run_id: reviewRun, name: "Mobile layout at 390px", state: "failed", source: "agent", detail: "Process section overflows by 12px." },
      { ...o, run_id: reviewRun, name: "Accessibility pass", state: "not_run", source: "agent" },
    ]),
    "checks",
  );
  await must(
    db.from("artifacts").insert([
      { ...o, run_id: reviewRun, kind: "pr", label: "PR #18", url: "https://github.com/denny/portfolio/pull/18", position: 0 },
      { ...o, run_id: reviewRun, kind: "preview", label: "Preview", url: "https://portfolio-preview.example.com", issue: "Protected deployment", position: 1 },
    ]),
    "artifacts",
  );

  // Conversation and activity
  await must(
    db.from("messages").insert([
      { ...o, task_id: tid["Add case study page template"]!, author: "denny", kind: "comment", body: "Keep the existing type scale." },
      { ...o, task_id: tid["Add case study page template"]!, author: "agent", agent: "claude_code", kind: "result", body: "Template added. See the Results tab.", run_id: reviewRun },
      { ...o, task_id: tid["Choose payment provider for checkout"]!, author: "agent", agent: "claude_code", kind: "question", body: "Which payment provider should checkout use?" },
    ]),
    "messages",
  );
  await must(
    db.from("activity").insert([
      { ...o, task_id: tid["Add case study page template"]!, run_id: reviewRun, actor: "Claude Code", action: "result_submitted", text: "Submitted a result for review", at: ago(240) },
      { ...o, task_id: tid["Choose payment provider for checkout"]!, actor: "Claude Code", action: "input_requested", text: "Asked: Which payment provider should checkout use?", at: ago(45) },
      { ...o, task_id: tid["Fix cart total rounding on mobile"]!, actor: "Denny", action: "queued", text: "Queued a run", at: ago(30) },
    ]),
    "activity",
  );

  await must(
    db.from("notifications").insert([
      { ...o, task_id: tid["Choose payment provider for checkout"]!, kind: "input_requested", text: "Claude Code needs a decision on the payment provider", group_key: "payment-input" },
      { ...o, task_id: tid["Add case study page template"]!, kind: "result_ready", text: "Result ready for review", group_key: "case-study-result" },
    ]),
    "notifications",
  );

  await must(
    db.from("integrations").upsert(
      [
        { ...o, key: "claude_code_mcp", state: "not_configured" },
        { ...o, key: "codex_mcp", state: "not_configured" },
        { ...o, key: "chatgpt", state: "not_configured" },
        { ...o, key: "github_events", state: "unavailable" },
      ],
      { onConflict: "key", ignoreDuplicates: true },
    ),
    "integrations",
  );

  await must(db.from("settings").upsert({ owner_id }, { onConflict: "owner_id" }), "settings");

  console.log(`Seeded ${projects.length} projects and ${tasks.length} tasks for ${allowedEmail}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
