"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { AgentKind, Project, Snapshot, Worker } from "@/lib/domain/types";
import { taskRef } from "@/lib/domain/rules";
import {
  ageShort, checkSummary, latestRun, needsItems, OWNER_LABEL, PRIORITY_LABEL, queueReason, secondaryLine, STEP_LABELS, type NeedsItem,
} from "@/lib/view";
import {
  createProjectAction, createTaskAction, issueTokenAction, registerWorkerAction, revokeTokenAction, revokeWorkerAction, signOutAction,
  updateProjectAction, updateSettingsAction,
} from "@/app/actions";
import { call, useRefresh, useSnapshot, useToast } from "@/components/providers";
import { Button } from "@/components/ui/button";
import {
  EmptyState, inputClass, labelClass, PageSkeleton, PriorityTag, ProviderLabel, ReasonChip, RelTime, RunStateBadge, StatusBadge, textareaClass,
} from "@/components/ui/kit";
import { cn } from "@/lib/utils";

const panel = "rounded-lg border border-border bg-card";
const counts = (s: Snapshot) => {
  const running = s.runs.filter((r) => r.state === "running").length;
  const queued = s.runs.filter((r) => r.state === "queued").length;
  return `${running} running, ${queued} queued.`;
};

// ---- Overview (PRD 10.1) ----

export function OverviewScreen() {
  const { data: s } = useSnapshot();
  if (!s) return <PageSkeleton />;
  const needs = needsItems(s);
  const running = s.runs.filter((r) => ["running", "pausing", "paused", "stopping"].includes(r.state));
  const queued = s.runs.filter((r) => r.state === "queued");
  const offline = s.workers.filter((w) => w.state === "offline" && queued.some((r) => r.worker_id === w.id));
  const taskOf = (id: string) => s.tasks.find((t) => t.id === id);
  const pname = (id: string) => s.projects.find((p) => p.id === id)?.name;

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
        <section aria-labelledby="attention">
          <h2 id="attention" className="mb-2 text-section font-semibold">Needs your attention</h2>
          {needs.answer.length ? (
            <ul className={cn(panel, "divide-y divide-border")}>
              {needs.answer.map((n) => (
                <li key={n.task.id} data-testid={`attention-${n.task.number}`} className="flex flex-col gap-2 p-3 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><ReasonChip>{n.reason}</ReasonChip><span className="text-sub text-muted-foreground">{taskRef(n.task.number)} · {pname(n.task.project_id)}{n.count > 1 ? ` · ${n.count} requests` : ""} · {ageShort(n.since)}</span></div>
                    <p className="mt-1 text-dense font-medium break-words">{n.task.title}</p>
                    <p className="line-clamp-2 text-sub break-words text-muted-foreground">{n.heading}</p>
                  </div>
                  <Button asChild className="h-11 shrink-0 md:h-[34px]"><Link href={`/tasks/${n.task.number}`}>{n.kind === "stalled" ? "Open" : "Answer"}</Link></Button>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Nothing needs you right now.">{counts(s)}</EmptyState>}
        </section>

        {!!needs.review.length && (
          <section aria-labelledby="ready">
            <h2 id="ready" className="mb-2 text-section font-semibold">Ready for review</h2>
            <ul className={cn(panel, "divide-y divide-border")}>
              {needs.review.map((n) => {
                const run = latestRun(s, n.task.id);
                return (
                  <li key={n.task.id} className="flex flex-col gap-2 p-3 md:flex-row md:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="text-dense font-medium break-words">{n.task.title}</p>
                      <p className="text-sub text-muted-foreground">{taskRef(n.task.number)} · {pname(n.task.project_id)} · {checkSummary(s.checks.filter((c) => c.run_id === run?.id)) ?? "No checks reported"}</p>
                    </div>
                    <Button asChild variant="secondary" className="h-11 shrink-0 md:h-[34px]"><Link href={`/tasks/${n.task.number}?tab=results`}>Review</Link></Button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!!running.length && (
          <section aria-labelledby="running">
            <h2 id="running" className="mb-2 text-section font-semibold">Running now</h2>
            <ul className={cn(panel, "divide-y divide-border")}>
              {running.map((r) => {
                const t = taskOf(r.task_id);
                if (!t) return null;
                const w = s.workers.find((x) => x.id === r.worker_id);
                return (
                  <li key={r.id} className="p-3">
                    <div className="flex flex-wrap items-center gap-2"><RunStateBadge state={r.state} /><Link href={`/tasks/${t.number}`} className="text-dense font-medium break-words hover:underline">{t.title}</Link></div>
                    <p className="mt-1 text-sub text-muted-foreground">{taskRef(t.number)} · {r.step_label ?? STEP_LABELS[r.step]} · {w?.name ?? "External session"}{r.note ? ` · ${r.note}` : ""}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-6 lg:col-span-4">
        <section aria-labelledby="queue">
          <h2 id="queue" className="mb-2 text-section font-semibold">Queue</h2>
          <div className={cn(panel, "p-3 text-dense")}>
            {queued.length ? (
              <ul className="flex flex-col gap-2">
                {queued.map((r) => {
                  const t = taskOf(r.task_id);
                  return t && <li key={r.id}><Link href={`/tasks/${t.number}`} className="font-medium break-words hover:underline">{t.title}</Link><p className="text-sub text-muted-foreground">{queueReason(s, r)}</p></li>;
                })}
              </ul>
            ) : <p className="text-muted-foreground">Nothing is queued.</p>}
            {offline.map((w) => <p key={w.id} className="mt-2 rounded-sm bg-warning-tint p-2 text-sub text-warning">{w.name} is offline, so queued work is waiting.</p>)}
          </div>
        </section>
        <section aria-labelledby="recent">
          <h2 id="recent" className="mb-2 text-section font-semibold">Recent activity</h2>
          <ul className={cn(panel, "flex flex-col gap-2 p-3 text-sub")}>
            {s.activity.slice(0, 7).map((a) => {
              const t = taskOf(a.task_id);
              return <li key={a.id}><span className="font-medium">{a.actor}</span> {a.text}{t && <> · <Link href={`/tasks/${t.number}`} className="underline">{taskRef(t.number)}</Link></>} · <span className="text-muted-foreground"><RelTime iso={a.at} /></span></li>;
            })}
            {!s.activity.length && <li className="text-muted-foreground">No activity yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ---- Needs Denny (PRD 10.5) ----

function NeedsCard({ s, n }: { s: Snapshot; n: NeedsItem }) {
  const project = s.projects.find((p) => p.id === n.task.project_id);
  return (
    <li data-testid={`needs-${n.task.number}`} className={cn(panel, "p-4")}>
      <div className="flex flex-wrap items-center gap-2 text-sub text-muted-foreground">
        <ReasonChip>{n.reason}</ReasonChip><PriorityTag priority={n.task.priority} />
        <span>{project?.name} · {taskRef(n.task.number)}</span>
        {n.count > 1 && <span>{n.count} requests</span>}
        {n.task.due_date && <span>Due {n.task.due_date}</span>}
      </div>
      <h3 className="mt-2 text-section font-semibold break-words">{n.heading}</h3>
      {n.kind !== "review" && <p className="mt-1 text-dense break-words text-text-secondary">{n.task.title}</p>}
      {n.blocks && <p className="mt-1 text-sub break-words text-muted-foreground">Blocks: {n.blocks}</p>}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-sub text-muted-foreground">Waiting {ageShort(n.since)}</span>
        <Button asChild className="h-11 md:h-[34px]">
          <Link href={`/tasks/${n.task.number}${n.kind === "review" ? "?tab=results" : ""}`}>{n.kind === "answer" ? "Answer" : n.kind === "stalled" ? "Open" : "Review result"}</Link>
        </Button>
      </div>
    </li>
  );
}

function NeedsInner() {
  const { data: s } = useSnapshot();
  const params = useSearchParams();
  const router = useRouter();
  if (!s) return <PageSkeleton />;
  const n = needsItems(s);
  const tab = params.get("tab") === "review" ? "review" : "answer";
  const list = tab === "review" ? n.review : n.answer;
  return (
    <div className="mx-auto max-w-3xl">
      <div role="tablist" aria-label="Needs Denny" className="mb-4 flex gap-1 border-b border-border">
        {([["answer", `Answer needed (${n.answer.length})`], ["review", `Review needed (${n.review.length})`]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => router.replace(`/needs?tab=${k}`)} className={cn("min-h-11 px-3 text-dense md:min-h-9", tab === k && "border-b-2 border-primary font-medium")}>{l}</button>
        ))}
      </div>
      {list.length ? <ul className="flex flex-col gap-3">{list.map((i) => <NeedsCard key={i.task.id} s={s} n={i} />)}</ul> : <EmptyState title="Nothing needs you right now">{counts(s)}</EmptyState>}
    </div>
  );
}
export const NeedsScreen = () => <Suspense fallback={<PageSkeleton />}><NeedsInner /></Suspense>;

// ---- Projects (PRD 10.7) ----

const workerText = (s: Snapshot, p: Project) => {
  const w = s.workers.find((x) => x.id === p.worker_id);
  return w ? `${w.name} · ${w.state.replace("_", " ")}` : "No worker · manual work only";
};

export function ProjectsScreen() {
  const { data: s } = useSnapshot();
  const router = useRouter();
  const toast = useToast();
  const refresh = useRefresh();
  const [name, setName] = useState("");
  if (!s) return <PageSkeleton />;
  const live = s.tasks.filter((t) => !t.archived_at && !t.cancelled_at);
  return (
    <div>
      <form className="mb-4 flex flex-col gap-2 md:max-w-md md:flex-row" onSubmit={async (e) => {
        e.preventDefault();
        const r = await call(() => createProjectAction({ name }));
        if (!r.ok) { toast(r.message); return; }
        setName(""); void refresh(); router.push(`/projects/${r.data.slug}?tab=settings`);
      }}>
        <label className="flex-1"><span className="sr-only">Project name</span><input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} /></label>
        <Button type="submit" variant="secondary" className="h-11 md:h-[34px]">Create project</Button>
      </form>
      <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {s.projects.filter((p) => !p.archived).map((p) => {
          const mine = live.filter((t) => t.project_id === p.id);
          const need = mine.filter((t) => t.status === "needs_denny" || t.status === "review").length;
          return (
            <li key={p.id} className={cn(panel, "p-4")}>
              <Link href={`/projects/${p.slug}`} className="text-section font-semibold hover:underline">{p.name}</Link>
              <p className="mt-1 text-dense text-text-secondary">{p.purpose || "No purpose set."}</p>
              <p className="mt-2 text-sub text-muted-foreground">{need} need attention · {mine.filter((t) => t.status !== "done").length} active · {mine.filter((t) => t.status === "done").length} done</p>
              <p className="text-sub text-muted-foreground">{workerText(s, p)}</p>
              <p className="text-sub break-words text-muted-foreground">{p.repo ?? "No repository"}</p>
            </li>
          );
        })}
      </ul>
      {!s.projects.length && <EmptyState title="No projects yet.">Create one above.</EmptyState>}
    </div>
  );
}

function Autosave({ label, value, onSave, multiline, placeholder, hint }: { label: string; value: string; onSave: (v: string) => Promise<void>; multiline?: boolean; placeholder?: string; hint?: string }) {
  const [v, setV] = useState(value);
  const cls = multiline ? textareaClass : inputClass;
  const commit = () => { if (v !== value) void onSave(v); };
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {multiline ? <textarea rows={3} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} className={cls} /> : <input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} className={cls} />}
      {hint && <span className="text-sub text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ProjectSettings({ s, p }: { s: Snapshot; p: Project }) {
  const refresh = useRefresh();
  const toast = useToast();
  const [saved, setSaved] = useState<"idle" | "saved">("idle");
  const save = async (patch: Record<string, unknown>) => {
    const r = await call(() => updateProjectAction({ id: p.id, patch }));
    if (!r.ok) { toast(r.message); return; }
    setSaved("saved");
    void refresh();
  };
  const nullable = (k: string) => async (v: string) => save({ [k]: v.trim() || null });
  const locked = ["Inspect the repository", "Edit an isolated branch", "Run approved verification commands", "Push the branch and open a draft PR"];
  const forbidden = ["Merge", "Production deploy", "Destructive data changes", "Client messages", "Spending"];
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p role="status" className="h-5 text-sub text-success">{saved === "saved" ? "Saved" : ""}</p>
      {!p.repo && <p className="rounded-md bg-warning-soft p-3 text-dense text-warning">This project has no repository, so it is manual work only. Tasks are tracked but no agent can run them.</p>}
      <Autosave label="Purpose" value={p.purpose} onSave={(v) => save({ purpose: v })} />
      <Autosave label="Context for agents" multiline value={p.context} onSave={(v) => save({ context: v })} />
      <Autosave label="Repository (optional, owner/name)" value={p.repo ?? ""} placeholder="owner/name" onSave={nullable("repo")} />
      <Autosave label="Base branch" value={p.base_branch ?? ""} placeholder="main" onSave={nullable("base_branch")} />
      <Autosave label="Preview URL" value={p.preview_url ?? ""} onSave={nullable("preview_url")} />
      <label className="flex flex-col gap-1"><span className={labelClass}>Worker</span>
        <select value={p.worker_id ?? ""} onChange={(e) => void save({ worker_id: e.target.value || null })} className={inputClass}>
          <option value="">No worker</option>{s.workers.map((w: Worker) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select></label>
      <label className="flex flex-col gap-1"><span className={labelClass}>Default agent</span>
        <select value={p.default_agent ?? ""} onChange={(e) => void save({ default_agent: (e.target.value || null) as AgentKind | null })} className={inputClass}>
          <option value="claude_code">Claude Code</option><option value="codex" disabled>Codex (not available yet)</option><option value="">None</option>
        </select></label>
      <label className="flex items-center gap-2 text-dense"><input type="checkbox" checked={p.pinned} onChange={(e) => void save({ pinned: e.target.checked })} /> Pin to the sidebar</label>
      <fieldset className="rounded-lg border border-border p-3"><legend className={cn(labelClass, "px-1")}>Execution mode</legend>
        <label className="flex items-center gap-2 text-dense"><input type="radio" checked readOnly /> Manual</label>
        <label className="mt-1 flex items-center gap-2 text-dense text-muted-foreground"><input type="radio" disabled /> Auto-run eligible tasks. Not available: every run is started by you.</label>
      </fieldset>
      <fieldset className="rounded-lg border border-border p-3"><legend className={cn(labelClass, "px-1")}>Allowed actions</legend>
        {locked.map((a) => <label key={a} className="flex items-center gap-2 text-dense"><input type="checkbox" checked disabled /> {a}</label>)}
        {forbidden.map((a) => <label key={a} className="mt-1 flex flex-wrap items-center gap-2 text-dense text-muted-foreground"><input type="checkbox" disabled /> {a} · Needs separate authorization</label>)}
      </fieldset>
      <details className="rounded-lg border border-border p-3">
        <summary className="min-h-11 cursor-pointer text-dense font-medium md:min-h-0">Advanced</summary>
        <div className="mt-3 flex flex-col gap-3">
          <Autosave label="Verification commands (one per line)" multiline value={p.verification_commands.join("\n")} onSave={(v) => save({ verification_commands: v.split("\n").map((x) => x.trim()).filter(Boolean) })} />
          <label className="flex flex-col gap-1"><span className={labelClass}>Automatic retries</span>
            <select value={p.retry_limit} onChange={(e) => void save({ retry_limit: Number(e.target.value) })} className={inputClass}><option value={0}>0</option><option value={1}>1</option><option value={2}>2</option></select></label>
          <Autosave label="Run time limit (minutes)" value={String(p.time_limit_minutes)} onSave={(v) => { const n = Number(v); return n > 0 ? save({ time_limit_minutes: n }) : Promise.resolve(toast("Enter a number of minutes.")); }} />
        </div>
      </details>
    </div>
  );
}

function ProjectInner({ slug }: { slug: string }) {
  const { data: s } = useSnapshot();
  const params = useSearchParams();
  const router = useRouter();
  if (!s) return <PageSkeleton />;
  const p = s.projects.find((x) => x.slug === slug);
  if (!p) return <EmptyState title="This project doesn't exist."><Link className="underline" href="/projects">All projects</Link></EmptyState>;
  const tab = params.get("tab") === "settings" ? "settings" : "tasks";
  const tasks = s.tasks.filter((t) => t.project_id === p.id && !t.archived_at && !t.cancelled_at);
  return (
    <div>
      <h2 className="text-title font-semibold">{p.name}</h2>
      <p className="text-dense text-text-secondary">{p.purpose}</p>
      <p className="mt-1 text-sub break-words text-muted-foreground">{p.repo ?? "No repository"}{p.base_branch ? ` · ${p.base_branch}` : ""}{p.preview_url ? ` · ${p.preview_url}` : ""} · {workerText(s, p)}</p>
      <div role="tablist" className="mt-4 mb-4 flex gap-1 border-b border-border">
        {(["tasks", "settings"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => router.replace(`/projects/${slug}?tab=${k}`)} className={cn("min-h-11 px-3 text-dense capitalize md:min-h-9", tab === k && "border-b-2 border-primary font-medium")}>{k}</button>
        ))}
      </div>
      {tab === "settings" ? <ProjectSettings key={p.id} s={s} p={p} /> : tasks.length ? (
        <ul className={cn(panel, "divide-y divide-border")}>
          {tasks.map((t) => (
            <li key={t.id} className="grid gap-1 p-3 md:grid-cols-[1fr_auto_auto_auto_auto_auto] md:items-center md:gap-4">
              <div className="min-w-0"><Link href={`/tasks/${t.number}`} className="text-dense font-medium break-words hover:underline">{t.title}</Link><p className="text-sub text-muted-foreground">{taskRef(t.number)} · {secondaryLine(s, t)}</p></div>
              <StatusBadge status={t.status} />
              <span className="text-sub text-muted-foreground">Next: {OWNER_LABEL[t.next_owner]}</span>
              <ProviderLabel agent={t.agent} />
              <span className="text-sub text-muted-foreground">{PRIORITY_LABEL[t.priority]}</span>
              <span className="text-sub text-muted-foreground"><RelTime iso={t.updated_at} /></span>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="No tasks in this project yet." />}
    </div>
  );
}
export const ProjectScreen = ({ slug }: { slug: string }) => <Suspense fallback={<PageSkeleton />}><ProjectInner slug={slug} /></Suspense>;

// ---- Settings (PRD 10.8) ----

function OneTime({ title, children, onDone }: { title: string; children: React.ReactNode; onDone: () => void }) {
  return (
    <div className="mt-3 rounded-md border border-warning-border bg-warning-soft p-3 text-dense">
      <p className="font-medium">{title}</p>
      <div className="mt-2">{children}</div>
      <Button variant="secondary" size="sm" className="mt-2" onClick={onDone}>I&apos;ve saved it</Button>
    </div>
  );
}
const Code = ({ children }: { children: string }) => <pre className="overflow-x-auto rounded-sm bg-muted p-2 text-sub whitespace-pre-wrap break-all">{children}</pre>;

const INTEGRATION_STATE = { not_configured: "Not configured", connected: "Connected", needs_auth: "Needs authentication", error: "Error", unavailable: "Unavailable" } as const;

export function mcpSnippet(appUrl: string, token: string) {
  return `claude mcp add --transport http task-workspace ${appUrl}/api/mcp --header "Authorization: Bearer ${token}"`;
}
const CLAUDE_MD = `## Task Workspace reporting
This repo reports to Task Workspace through the \`task-workspace\` MCP server.
- At the start of work on a task, call \`link_session\` with the task ID (for example TW-142). If no task exists, ask Denny before calling \`create_task\`.
- Post a short \`post_update\` when you move between reading, editing, checking and preparing the result.
- If you need a decision, asset, access or a manual action from Denny, call \`ask_denny\` with a clear question, why it matters, what it blocks, and choices when useful. Then poll \`get_answer\` and do not guess.
- When finished, call \`submit_result\` with a summary, changes, limitations, explicit checks (Passed, Failed, Not run, Unknown) and links to the preview, screenshots, PR or commit. Never report a check as Passed unless you ran it.
- Never merge, deploy, change production data or message clients.`;

function ReportingRow({ s, ikey, name, note }: { s: Snapshot; ikey: "claude_code_mcp" | "codex_mcp"; name: string; note: string }) {
  const refresh = useRefresh();
  const toast = useToast();
  const row = s.integrations.find((i) => i.key === ikey);
  const [token, setToken] = useState<string | null>(null);
  return (
    <li className="p-4" data-testid={`integration-${ikey}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-dense font-medium">{name}</p>
          <p className="text-sub text-muted-foreground">{note} · {INTEGRATION_STATE[row?.state ?? "not_configured"]}{row?.last_success_at ? <> · Last event <RelTime iso={row.last_success_at} /></> : ""}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="h-11 md:h-[34px]" onClick={async () => {
            const r = await call(() => issueTokenAction({ key: ikey }));
            if (!r.ok) { toast(r.message); return; }
            setToken(r.data.token); void refresh();
          }}>{row?.has_token ? "Replace token" : "Generate token"}</Button>
          {row?.has_token && <Button variant="ghost" className="h-11 md:h-[34px]" onClick={async () => {
            const r = await call(() => revokeTokenAction({ key: ikey }));
            if (!r.ok) toast(r.message);
            setToken(null); void refresh();
          }}>Revoke</Button>}
        </div>
      </div>
      {token && (
        <OneTime title="Copy this now. It won't be shown again." onDone={() => setToken(null)}>
          <Code>{mcpSnippet(typeof window === "undefined" ? "" : window.location.origin, token)}</Code>
        </OneTime>
      )}
    </li>
  );
}

function SettingsInner() {
  const { data: s } = useSnapshot();
  const params = useSearchParams();
  const router = useRouter();
  const refresh = useRefresh();
  const toast = useToast();
  const [workerName, setWorkerName] = useState("Denny-PC");
  const [machine, setMachine] = useState("Windows with WSL2");
  const [workerToken, setWorkerToken] = useState<string | null>(null);
  if (!s) return <PageSkeleton />;
  const sections = [["connections", "Reporting connections"], ["workers", "Workers and agents"], ["preferences", "Preferences"], ["execution", "Execution defaults"], ["notifications", "Notifications"]] as const;
  const sec = sections.find(([k]) => k === params.get("section"))?.[0] ?? "connections";
  const zones = ["device", "Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "UTC"];
  const anyAgent = s.workers.some((w) => w.supported_agents.includes("claude_code"));

  return (
    <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
      <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
        {sections.map(([k, l]) => (
          <button key={k} aria-current={sec === k ? "page" : undefined} onClick={() => router.replace(`/settings?section=${k}`)} className={cn("min-h-11 shrink-0 rounded-md px-3 text-left text-dense md:min-h-9", sec === k && "bg-accent font-medium text-accent-foreground")}>{l}</button>
        ))}
      </nav>
      <div className="flex min-w-0 max-w-3xl flex-col gap-4">
        {sec === "connections" && (
          <>
            <ul className={cn(panel, "divide-y divide-border")}>
              <ReportingRow s={s} ikey="claude_code_mcp" name="Claude Code reporting (MCP)" note="Sessions report tasks here" />
              <ReportingRow s={s} ikey="codex_mcp" name="Codex reporting (MCP)" note="Reporting only, no execution" />
              <li className="p-4"><p className="text-dense font-medium">ChatGPT connection</p><p className="text-sub text-muted-foreground">Not configured</p></li>
              <li className="p-4"><p className="text-dense font-medium">GitHub events</p><p className="text-sub text-muted-foreground">Unavailable · later</p></li>
            </ul>
            <div className={cn(panel, "p-4")}><p className="mb-2 text-dense font-medium">Add this to each project&apos;s CLAUDE.md</p><Code>{CLAUDE_MD}</Code></div>
          </>
        )}
        {sec === "workers" && (
          <>
            <ul className={cn(panel, "divide-y divide-border")}>
              {s.workers.map((w) => {
                const active = s.runs.find((r) => r.worker_id === w.id && r.state === "running");
                const t = active && s.tasks.find((x) => x.id === active.task_id);
                return (
                  <li key={w.id} data-testid="worker-row" className="flex flex-wrap items-center justify-between gap-2 p-4">
                    <div>
                      <p className="text-dense font-medium">{w.name} · {w.state.replace("_", " ")}</p>
                      <p className="text-sub text-muted-foreground">{w.machine_label} · {w.supported_agents.length ? "Claude Code" : "No agents reported"} · Last seen {w.last_seen_at ? <RelTime iso={w.last_seen_at} /> : "never"}{t ? ` · Running ${taskRef(t.number)}` : ""}</p>
                      {w.held_until && new Date(w.held_until) > new Date() && <p className="text-sub text-warning">{w.hold_reason}</p>}
                    </div>
                    <Button variant="ghost" className="h-11 md:h-[34px]" onClick={async () => { const r = await call(() => revokeWorkerAction({ id: w.id })); if (!r.ok) toast(r.message); void refresh(); }}>Revoke</Button>
                  </li>
                );
              })}
              {!s.workers.length && <li className="p-4 text-dense text-muted-foreground">No worker registered · tracking only</li>}
            </ul>
            <form className={cn(panel, "flex flex-col gap-3 p-4")} onSubmit={async (e) => {
              e.preventDefault();
              const r = await call(() => registerWorkerAction({ name: workerName, machine_label: machine }));
              if (!r.ok) { toast(r.message); return; }
              setWorkerToken(r.data.token); void refresh();
            }}>
              <p className="text-dense font-medium">Register a worker</p>
              <label className="flex flex-col gap-1"><span className={labelClass}>Name</span><input value={workerName} onChange={(e) => setWorkerName(e.target.value)} className={inputClass} /></label>
              <label className="flex flex-col gap-1"><span className={labelClass}>Machine label</span><input value={machine} onChange={(e) => setMachine(e.target.value)} className={inputClass} /></label>
              <div><Button type="submit" className="h-11 md:h-[34px]">Register worker</Button></div>
              {workerToken && (
                <OneTime title="Run this on the worker machine. The token won't be shown again." onDone={() => setWorkerToken(null)}>
                  <Code>{`WORKER_TOKEN=${workerToken} APP_URL=${typeof window === "undefined" ? "" : window.location.origin} WORKSPACE_ROOT=~/task-workspace pnpm --filter @task-workspace/worker start`}</Code>
                </OneTime>
              )}
            </form>
            <ul className={cn(panel, "divide-y divide-border")}>
              <li className="p-4 text-dense">Claude Code · <span className="text-muted-foreground">{anyAgent ? "Available" : "Not reported by a worker yet"}</span></li>
              <li className="p-4 text-dense">Codex · <span className="text-muted-foreground">Not available yet</span></li>
            </ul>
          </>
        )}
        {sec === "preferences" && (
          <div className={cn(panel, "flex flex-col gap-3 p-4")}>
            <label className="flex flex-col gap-1"><span className={labelClass}>Timezone</span>
              <select value={s.settings?.timezone ?? "device"} onChange={async (e) => { const tz = e.target.value; const r = await call(() => updateSettingsAction({ timezone: tz })); if (!r.ok) toast(r.message); void refresh(); }} className={inputClass}>
                {zones.map((z) => <option key={z} value={z}>{z === "device" ? "Device default" : z}</option>)}
              </select></label>
            <p className="text-dense">Interface language: English. Indonesian content is supported everywhere.</p>
            <form action={signOutAction}><Button type="submit" variant="secondary" className="h-11 md:h-[34px]">Sign out</Button></form>
          </div>
        )}
        {sec === "execution" && (
          <ul className={cn(panel, "list-disc space-y-2 p-4 pl-8 text-dense")}>
            <li>Execution is manual: you start every run.</li><li>Every result needs your review.</li><li>One writer per project at a time.</li><li>No confidence routing. Waiting reasons are concrete.</li>
          </ul>
        )}
        {sec === "notifications" && (
          <ul className={cn(panel, "divide-y divide-border text-dense")}>
            <li className="p-4">In-app · <span className="text-success">On</span></li>
            {["Push", "Email", "Telegram", "WhatsApp"].map((n) => <li key={n} className="p-4 text-muted-foreground">{n} · Later</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
export const SettingsScreen = () => <Suspense fallback={<PageSkeleton />}><SettingsInner /></Suspense>;

// ---- First use (PRD 10.10) ----

export function SetupScreen() {
  const { data: s } = useSnapshot();
  const router = useRouter();
  const refresh = useRefresh();
  const [step, setStep] = useState(0);
  const [project, setProject] = useState({ id: "", name: "", purpose: "", repo: "", context: "" });
  const [task, setTask] = useState({ title: "", brief: "" });
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const titles = ["Create a project", "Add context", "Connect reporting", "Register a worker", "Create your first task"];
  if (!s) return <PageSkeleton />;

  const go = (n: number) => { setError(null); setStep(n); void call(() => updateSettingsAction({ setup_step: n })); };
  const finish = async () => {
    await call(() => updateSettingsAction({ setup_completed: true, setup_step: titles.length }));
    await refresh();
    router.replace("/");
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <p className="text-sub text-muted-foreground">Step {step + 1} of {titles.length}</p>
      <div role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={titles.length} aria-valuenow={step + 1} className="mt-2 h-1 rounded-sm bg-border"><div className="h-1 rounded-sm bg-primary" style={{ width: `${((step + 1) / titles.length) * 100}%` }} /></div>
      <h1 className="mt-6 text-title font-semibold">{titles[step]}</h1>
      <div className="mt-4 flex flex-col gap-3">
        {step === 0 && (
          <>
            <label className="flex flex-col gap-1"><span className={labelClass}>Name</span><input value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} className={inputClass} /></label>
            <label className="flex flex-col gap-1"><span className={labelClass}>Purpose (one line)</span><input value={project.purpose} onChange={(e) => setProject({ ...project, purpose: e.target.value })} className={inputClass} /></label>
            <label className="flex flex-col gap-1"><span className={labelClass}>Repository (optional, owner/name)</span><input value={project.repo} onChange={(e) => setProject({ ...project, repo: e.target.value })} className={inputClass} /></label>
          </>
        )}
        {step === 1 && <label className="flex flex-col gap-1"><span className={labelClass}>Brief for agents</span><textarea rows={5} value={project.context} onChange={(e) => setProject({ ...project, context: e.target.value })} className={textareaClass} /></label>}
        {step === 2 && (
          <>
            <p className="text-dense">Lets your Claude Code sessions report into this app.</p>
            {token ? <Code>{mcpSnippet(window.location.origin, token)}</Code> : (
              <div><Button variant="secondary" className="h-11 md:h-[34px]" onClick={async () => { const r = await call(() => issueTokenAction({ key: "claude_code_mcp" })); if (r.ok) setToken(r.data.token); else setError(r.message); }}>Generate token</Button></div>
            )}
          </>
        )}
        {step === 3 && <p className="text-dense">A worker runs Claude Code on its own. You can register one later in Settings › Workers. The board works without it.</p>}
        {step === 4 && (
          <>
            <label className="flex flex-col gap-1"><span className={labelClass}>Title</span><input value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} className={inputClass} /></label>
            <label className="flex flex-col gap-1"><span className={labelClass}>Outcome and brief</span><textarea rows={4} value={task.brief} onChange={(e) => setTask({ ...task, brief: e.target.value })} className={textareaClass} /></label>
          </>
        )}
        {error && <p role="alert" className="text-dense text-danger">{error}</p>}
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {(step === 2 || step === 3 || step === 4) && <Button variant="ghost" className="h-11 md:h-[34px]" onClick={() => (step === 4 ? void finish() : go(step + 1))}>Skip</Button>}
        <Button className="h-11 md:h-[34px]" onClick={async () => {
          if (step === 0) {
            const r = await call(() => createProjectAction({ name: project.name, purpose: project.purpose, repo: project.repo.trim() || null }));
            if (!r.ok) { setError(r.message); return; }
            setProject((p) => ({ ...p, id: r.data.id }));
            void refresh();
            go(1);
          } else if (step === 1) {
            const r = await call(() => updateProjectAction({ id: project.id, patch: { context: project.context } }));
            if (!r.ok) { setError(r.message); return; }
            go(2);
          } else if (step === 4) {
            const r = await call(() => createTaskAction({ project_id: project.id, title: task.title, brief: task.brief, criteria: [] }));
            if (!r.ok) { setError(r.message); return; }
            await finish();
          } else go(step + 1);
        }}>{step === 4 ? "Save to Inbox and finish" : "Continue"}</Button>
      </div>
    </main>
  );
}
