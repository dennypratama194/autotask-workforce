"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { Bell, FolderKanban, Inbox, LayoutDashboard, ListTodo, Plus, Search, Settings as SettingsIcon, WifiOff, X } from "lucide-react";
import type { Snapshot } from "@/lib/domain/types";
import { taskRef } from "@/lib/domain/rules";
import { ago, needsItems } from "@/lib/view";
import { createTaskAction, markReadAction } from "@/app/actions";
import { call, useBlocked, useRefresh, useSnapshot, useToast } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { inputClass, labelClass, RelTime, textareaClass } from "@/components/ui/kit";
import { cn } from "@/lib/utils";

const TITLES: [RegExp, string, string][] = [
  [/^\/$/, "Overview", "What needs you and what is moving."],
  [/^\/tasks/, "All tasks", "Every task across your projects."],
  [/^\/needs/, "Needs Denny", "Answers and reviews waiting on you."],
  [/^\/projects/, "Projects", "Where the work lives."],
  [/^\/settings/, "Settings", "Connections, workers and preferences."],
];

function useAttention(s: Snapshot | undefined) {
  return useMemo(() => {
    if (!s) return 0;
    const n = needsItems(s);
    return n.answer.reduce((a, i) => a + i.count, 0) + n.review.length;
  }, [s]);
}

function workerLine(s: Snapshot) {
  if (!s.workers.length) return "No worker · tracking only";
  return s.workers.map((w) => `${w.name} · ${w.state.replace("_", " ")}`).join(", ");
}

function Sidebar({ s }: { s: Snapshot | undefined }) {
  const pathname = usePathname();
  const attention = useAttention(s);
  const items = [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    { href: "/tasks", label: "All tasks", icon: ListTodo },
    { href: "/needs", label: "Needs Denny", icon: Inbox, badge: attention },
    { href: "/projects", label: "Projects", icon: FolderKanban },
    { href: "/settings", label: "Settings", icon: SettingsIcon },
  ];
  const pinned = s?.projects.filter((p) => p.pinned && !p.archived) ?? [];
  return (
    <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-border bg-sidebar p-3 md:flex">
      <p className="mb-4 px-2 pt-1 text-section font-semibold">Task Workspace</p>
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {items.map((i) => {
          const on = i.href === "/" ? pathname === "/" : pathname.startsWith(i.href);
          return (
            <Link key={i.href} href={i.href} aria-current={on ? "page" : undefined} className={cn("flex h-[34px] items-center gap-2 rounded-md px-2 text-dense hover:bg-muted", on && "bg-accent font-medium text-accent-foreground")}>
              <i.icon size={16} aria-hidden /><span className="flex-1">{i.label}</span>
              {!!i.badge && <span data-testid="attention-count" className="rounded-sm bg-warning-tint px-1.5 text-label font-medium text-warning">{i.badge}</span>}
            </Link>
          );
        })}
      </nav>
      {!!pinned.length && (
        <div className="mt-6">
          <p className="px-2 pb-1 text-label font-medium text-muted-foreground">Pinned projects</p>
          {pinned.map((p) => {
            const need = s!.tasks.filter((t) => t.project_id === p.id && (t.status === "needs_denny" || t.status === "review") && !t.archived_at && !t.cancelled_at).length;
            return (
              <Link key={p.id} href={`/projects/${p.slug}`} className="flex min-h-[34px] items-center justify-between gap-2 rounded-md px-2 text-dense hover:bg-muted">
                <span className="truncate">{p.name}</span>
                {!!need && <span className="shrink-0 text-label text-warning">{need} need you</span>}
              </Link>
            );
          })}
        </div>
      )}
      {s && <p className="mt-auto rounded-md border border-border bg-card p-2 text-sub text-muted-foreground">{workerLine(s)}</p>}
    </aside>
  );
}

function TabBar({ s }: { s: Snapshot | undefined }) {
  const pathname = usePathname();
  const attention = useAttention(s);
  const items = [
    { href: "/", label: "Overview", icon: LayoutDashboard },
    { href: "/needs", label: "Needs Denny", icon: Inbox, badge: attention },
    { href: "/tasks", label: "Tasks", icon: ListTodo },
    { href: "/projects", label: "Projects", icon: FolderKanban },
    { href: "/settings", label: "Settings", icon: SettingsIcon },
  ];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map((i) => {
        const on = i.href === "/" ? pathname === "/" : pathname.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={on ? "page" : undefined} className={cn("relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-label", on ? "font-medium text-accent-foreground" : "text-muted-foreground")}>
            <i.icon size={18} aria-hidden />
            <span className="truncate">{i.label}</span>
            {!!i.badge && <span data-testid="attention-count-mobile" className="absolute top-1 left-1/2 ml-2 rounded-sm bg-warning-tint px-1 text-label font-medium text-warning">{i.badge}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function SearchBox({ s }: { s: Snapshot | undefined }) {
  const [text, setText] = useState("");
  const router = useRouter();
  const results = useMemo(() => {
    const n = text.trim().toLowerCase();
    if (!n || !s) return [];
    return s.tasks.filter((t) => {
      const p = s.projects.find((x) => x.id === t.project_id)?.name ?? "";
      return `${taskRef(t.number)} ${t.title} ${t.brief} ${p}`.toLowerCase().includes(n);
    }).slice(0, 7);
  }, [text, s]);
  return (
    <div className="relative w-full md:w-64">
      <Search size={14} aria-hidden className="absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
      <input aria-label="Search tasks" placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setText(""); }} className={cn(inputClass, "pl-8")} />
      {!!text.trim() && (
        <div className="absolute inset-x-0 top-full z-40 mt-1 rounded-md border border-border bg-popover p-1 shadow-lg">
          {results.map((t) => (
            <button key={t.id} onClick={() => { setText(""); router.push(`/tasks/${t.number}`); }} className="block min-h-11 w-full rounded-sm px-2 py-1.5 text-left text-dense hover:bg-accent md:min-h-0">
              <span className="text-muted-foreground">{taskRef(t.number)}</span> {t.title}
            </button>
          ))}
          {!results.length && <p className="px-2 py-2 text-dense text-muted-foreground">No tasks found.</p>}
        </div>
      )}
    </div>
  );
}

function Notifications({ s }: { s: Snapshot | undefined }) {
  const router = useRouter();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const list = s?.notifications ?? [];
  const unread = list.filter((n) => !n.read_at).length;
  const KIND = { input_requested: "Question", result_ready: "Result ready", failure_needs_action: "Failure" } as const;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger aria-label={`Notifications, ${unread} unread`} className="relative grid size-11 shrink-0 place-items-center rounded-md border border-border bg-card md:size-[34px]">
        <Bell size={16} aria-hidden />
        {!!unread && <span className="absolute -top-1 -right-1 rounded-sm bg-primary px-1 text-label font-medium text-primary-foreground">{unread}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={8} className="z-50 w-[min(360px,calc(100vw-32px))] rounded-lg border border-border bg-popover p-2 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1">
            <h2 className="text-dense font-semibold">Notifications</h2>
            {!!unread && <button className="min-h-11 text-sub font-medium text-accent-foreground underline md:min-h-0" onClick={async () => { await call(() => markReadAction({ id: "all" })); void refresh(); }}>Mark all read</button>}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {list.map((n) => {
              const t = s?.tasks.find((x) => x.id === n.task_id);
              return (
                <li key={n.id}>
                  <button
                    className={cn("block w-full rounded-sm px-2 py-2 text-left hover:bg-accent", !n.read_at && "bg-accent/40")}
                    onClick={async () => {
                      setOpen(false);
                      if (t) router.push(`/tasks/${t.number}${n.request_id ? `#request-${n.request_id}` : ""}`);
                      await call(() => markReadAction({ id: n.id }));
                      void refresh();
                    }}
                  >
                    <span className="text-label font-medium text-muted-foreground">{KIND[n.kind]} · <RelTime iso={n.created_at} />{n.read_at ? "" : " · Unread"}</span>
                    <span className="mt-0.5 block text-dense break-words">{n.text}</span>
                  </button>
                </li>
              );
            })}
            {!list.length && <li className="px-2 py-4 text-dense text-muted-foreground">No notifications.</li>}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---- dialogs ----

const dialogClass = "fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-xl";
const overlayClass = "fixed inset-0 z-40 bg-foreground/30";

function BlockedDialog() {
  const { blocked, setBlocked } = useBlocked();
  return (
    <Dialog.Root open={!!blocked} onOpenChange={(o) => { if (!o) setBlocked(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content className={dialogClass} aria-describedby={undefined}>
          <Dialog.Title className="text-section font-semibold">{blocked?.title}</Dialog.Title>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-dense">{blocked?.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            {blocked?.projectSlug && <Button variant="secondary" asChild><Link href={`/projects/${blocked.projectSlug}?tab=settings`} onClick={() => setBlocked(null)}>Open project settings</Link></Button>}
            {blocked?.taskNumber && <Button variant="secondary" asChild><Link href={`/tasks/${blocked.taskNumber}`} onClick={() => setBlocked(null)}>Open task</Link></Button>}
            <Dialog.Close asChild><Button>Close</Button></Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NewTaskDialog({ s, open, onOpenChange }: { s: Snapshot | undefined; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const toast = useToast();
  const refresh = useRefresh();
  const { setBlocked } = useBlocked();
  const projects = s?.projects.filter((p) => !p.archived) ?? [];
  const [form, setForm] = useState({ title: "", project_id: "", brief: "", criteria: "", reference_url: "", priority: "normal", due_date: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pid = form.project_id || projects[0]?.id || "";
  const project = projects.find((p) => p.id === pid);
  const worker = s?.workers.find((w) => w.id === project?.worker_id);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const missing = [
    !project?.repo && "This project has no repository. Coding runs need one (Project settings › Repository).",
    !project?.worker_id && "No worker is assigned to this project.",
    form.brief.trim().length < 20 && "The brief is too short to act on. Describe the outcome in a sentence or two.",
  ].filter(Boolean) as string[];

  async function submit(run_with_ai: boolean) {
    if (!form.title.trim()) { setError("A task needs a title."); return; }
    if (!pid) { setError("Create a project first."); return; }
    setBusy(true); setError(null);
    const r = await call(() => createTaskAction({
      project_id: pid, title: form.title, brief: form.brief, criteria: form.criteria.split("\n").map((x) => x.trim()).filter(Boolean),
      reference_url: form.reference_url.trim() || null, priority: form.priority as "normal", due_date: form.due_date || null, run_with_ai,
    }));
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    onOpenChange(false);
    setForm({ title: "", project_id: "", brief: "", criteria: "", reference_url: "", priority: "normal", due_date: "" });
    void refresh();
    toast(run_with_ai ? "Task created and queued." : "Saved to Inbox.");
    if (r.data.blocked.length) setBlocked({ title: "Saved to Inbox. It could not be queued.", reasons: r.data.blocked, projectSlug: project?.slug, taskNumber: r.data.number });
    router.push(`/tasks/${r.data.number}`);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content className={dialogClass} aria-describedby={undefined} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submit(false); } }}>
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-section font-semibold">New task</Dialog.Title>
            <Dialog.Close aria-label="Close" className="grid size-11 place-items-center rounded-md hover:bg-muted md:size-7"><X size={16} aria-hidden /></Dialog.Close>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1"><span className={labelClass}>Title (required)</span>
              <input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} className={inputClass} /></label>
            <label className="flex flex-col gap-1"><span className={labelClass}>Project</span>
              <select value={pid} onChange={(e) => set("project_id", e.target.value)} className={inputClass}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
            <label className="flex flex-col gap-1"><span className={labelClass}>Outcome and brief</span>
              <textarea rows={4} value={form.brief} onChange={(e) => set("brief", e.target.value)} className={textareaClass} /></label>
            <label className="flex flex-col gap-1"><span className={labelClass}>Acceptance criteria (one per line, optional)</span>
              <textarea rows={3} value={form.criteria} onChange={(e) => set("criteria", e.target.value)} className={textareaClass} /></label>
            <label className="flex flex-col gap-1"><span className={labelClass}>Reference link (optional)</span>
              <input type="url" value={form.reference_url} onChange={(e) => set("reference_url", e.target.value)} className={inputClass} /></label>
            <details>
              <summary className="min-h-11 cursor-pointer text-sub font-medium md:min-h-0">More options</summary>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1"><span className={labelClass}>Priority</span>
                  <select value={form.priority} onChange={(e) => set("priority", e.target.value)} className={inputClass}>
                    <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
                  </select></label>
                <label className="flex flex-col gap-1"><span className={labelClass}>Due date</span>
                  <input type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} className={inputClass} /></label>
              </div>
            </details>
            <div className="rounded-lg border border-border bg-muted p-3 text-sub text-text-secondary">
              <p className="font-medium">If you run this with AI</p>
              <p className="mt-1">{project?.name ?? "No project"} · {project?.repo ? `${project.repo} (${project.base_branch ?? "main"})` : "No repository"} · Claude Code · {worker ? `${worker.name}, ${worker.state.replace("_", " ")}` : "No worker"}</p>
              <p className="mt-1">Inspect the repository, edit an isolated branch, run approved checks, prepare a reviewable change. No merge, deploy or client messages.</p>
              {worker?.state === "offline" && <p className="mt-1 text-warning">The worker is offline. The run starts when it comes back.</p>}
              {!!missing.length && <ul className="mt-2 list-disc pl-4 text-warning">{missing.map((m) => <li key={m}>{m}</li>)}</ul>}
            </div>
            {error && <p role="alert" className="text-dense text-danger">{error}</p>}
          </div>
          <div className="mt-6 flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="secondary" disabled={busy || missing.length > 0} onClick={() => void submit(true)} className="h-11 md:h-[34px]" title={missing[0]}>Run with AI</Button>
            <Button disabled={busy} onClick={() => void submit(false)} className="h-11 md:h-[34px]">Save to Inbox</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---- frame ----

export function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    const first = setTimeout(on, 0);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => { clearTimeout(first); window.removeEventListener("online", on); window.removeEventListener("offline", on); };
  }, []);
  return online;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { data: s, error } = useSnapshot();
  const pathname = usePathname();
  const router = useRouter();
  const online = useOnline();
  const [newOpen, setNewOpen] = useState(false);
  const title = TITLES.find(([re]) => re.test(pathname));
  const onDetail = /^\/tasks\/\d+/.test(pathname);

  useEffect(() => {
    if (s && !s.settings?.setup_completed_at && !s.projects.length) router.replace("/setup");
  }, [s, router]);

  return (
    <div className="flex min-h-dvh">
      <Sidebar s={s} />
      <div className="flex min-w-0 flex-1 flex-col">
        {!online && (
          <div role="status" className="flex items-center gap-2 bg-warning-tint px-4 py-2 text-dense text-warning">
            <WifiOff size={14} aria-hidden /> You&apos;re offline. Drafts stay here. Anything you send is marked Not sent until you reconnect.
          </div>
        )}
        <header className={cn("border-b border-border bg-card px-4 py-3 md:px-6", onDetail && "hidden md:block")}>
          <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
            <div className="mr-auto min-w-0">
              <h1 className="text-section font-semibold">{title?.[1]}</h1>
              <p className="hidden text-sub text-muted-foreground md:block">{title?.[2]}</p>
            </div>
            <Notifications s={s} />
            <Button disabled={!s} onClick={() => setNewOpen(true)} className="h-11 md:h-[34px]"><Plus size={16} aria-hidden />New task</Button>
            <div className="order-last w-full md:order-none md:w-auto"><SearchBox s={s} /></div>
          </div>
        </header>
        <main className={cn("mx-auto w-full max-w-[1440px] flex-1 px-4 py-4 md:px-6 md:py-6", !onDetail && "pb-24 md:pb-6")}>
          {error && !s ? <p role="alert" className="text-dense text-danger">{error.message} It will retry shortly. Last checked {ago(new Date().toISOString())}.</p> : children}
        </main>
      </div>
      {!onDetail && <TabBar s={s} />}
      <NewTaskDialog s={s} open={newOpen} onOpenChange={setNewOpen} />
      <BlockedDialog />
    </div>
  );
}
