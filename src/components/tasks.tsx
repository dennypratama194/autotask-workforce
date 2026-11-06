"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCorners, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ArrowDown, ArrowUp, Columns3, List, MoreHorizontal } from "lucide-react";
import type { Snapshot, Task, TaskStatus } from "@/lib/domain/types";
import { checkMove, STATUSES, taskRef } from "@/lib/domain/rules";
import {
  activeRunOf, AGENT_LABEL, applyFilters, EMPTY_FILTERS, filtersActive, hasNewResult, isNew, OWNER_LABEL, PRIORITY_LABEL, secondaryLine,
  STATUS_LABEL, type Filters,
} from "@/lib/view";
import { moveTaskAction, reorderTaskAction } from "@/app/actions";
import { call, useBlocked, useSnapshot, useToast } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { EmptyState, inputClass, PageSkeleton, PriorityTag, ProviderLabel, RelTime, StatusBadge } from "@/components/ui/kit";
import { cn } from "@/lib/utils";

// ---- moving ----

export function useMoveTask() {
  const qc = useQueryClient();
  const toast = useToast();
  const { setBlocked } = useBlocked();
  const router = useRouter();

  return useCallback(async function move(task: Task, to: TaskStatus, sort_order?: number): Promise<boolean> {
    const s = qc.getQueryData<Snapshot>(["snapshot"]);
    const openTask = { label: "Open task", run: () => router.push(`/tasks/${task.number}`) };
    if (s) {
      // Instant refusal for known-invalid moves; the server re-checks everything.
      const check = checkMove({
        from: task.status,
        activeRun: activeRunOf(s, task.id)?.state ?? null,
        hasResult: s.resultRunIds.some((id) => s.runs.some((r) => r.id === id && r.task_id === task.id)),
      }, to);
      if (!check.ok) {
        toast(check.message, task.status === to ? undefined : openTask);
        return false;
      }
      qc.setQueryData<Snapshot>(["snapshot"], {
        ...s,
        tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, status: to, sort_order: sort_order ?? Date.now() } : t)),
      });
    }
    const r = await call(() => moveTaskAction({ id: task.id, to, sort_order }));
    if (!r.ok) {
      if (s) qc.setQueryData(["snapshot"], s);
      if (r.blocked?.length) {
        const slug = s?.projects.find((p) => p.id === task.project_id)?.slug;
        setBlocked({ title: r.message, reasons: r.blocked, projectSlug: slug, taskNumber: task.number });
      } else {
        toast(r.network ? `${r.message} The card is back where it was.` : r.message, r.network ? { label: "Retry", run: () => void move(task, to, sort_order) } : openTask);
      }
      return false;
    }
    if (r.data.message) toast(r.data.message);
    void qc.invalidateQueries();
    return true;
  }, [qc, toast, setBlocked, router]);
}

export function MoveMenu({ task }: { task: Task }) {
  const move = useMoveTask();
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button aria-label={`Move ${taskRef(task.number)}`} className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted md:size-7" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <MoreHorizontal size={16} aria-hidden />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" className="z-50 min-w-44 rounded-md border border-border bg-popover p-1 shadow-lg">
          <Menu.Label className="px-2 py-1 text-label text-muted-foreground">Move to</Menu.Label>
          {STATUSES.map((s) => (
            <Menu.Item key={s} disabled={s === task.status} onSelect={() => void move(task, s)} className="cursor-pointer rounded-sm px-2 py-2 text-dense outline-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[highlighted]:bg-accent">
              {STATUS_LABEL[s]}{s === task.status ? " (current)" : ""}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

// ---- filters (PRD 10.4) ----

const STORE_KEY = "tw:tasks-view";
const PARAMS: (keyof Filters)[] = ["q", "project", "owner", "agent", "priority", "status"];

export function useTaskView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Restore the last view and filters when the URL has none. Only on the list route.
  useEffect(() => {
    if (pathname !== "/tasks" || params.toString()) return;
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) router.replace(`/tasks?${saved}`);
    } catch { /* storage may be blocked */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filters: Filters = useMemo(() => {
    const f = { ...EMPTY_FILTERS };
    for (const k of PARAMS) (f[k] as string) = params.get(k) ?? "";
    f.archived = params.get("archived") === "1";
    return f;
  }, [params]);
  const view = (params.get("view") as "kanban" | "list" | null);

  const write = useCallback((next: URLSearchParams) => {
    const str = next.toString();
    try { localStorage.setItem(STORE_KEY, str); } catch { /* storage may be blocked */ }
    router.replace(str ? `/tasks?${str}` : "/tasks", { scroll: false });
  }, [router]);

  const setFilter = useCallback((k: keyof Filters, v: string | boolean) => {
    const next = new URLSearchParams(params.toString());
    if (k === "archived") { if (v) next.set("archived", "1"); else next.delete("archived"); }
    else if (v) next.set(k, String(v));
    else next.delete(k);
    write(next);
  }, [params, write]);

  const clear = useCallback(() => {
    const next = new URLSearchParams();
    if (view) next.set("view", view);
    write(next);
  }, [view, write]);

  const setView = useCallback((v: "kanban" | "list") => {
    const next = new URLSearchParams(params.toString());
    next.set("view", v);
    write(next);
  }, [params, write]);

  return { filters, view, setFilter, clear, setView };
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputClass, "w-full md:w-auto")}>
        <option value="">{label}: All</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function FilterBar({ s, view, shown }: { s: Snapshot; view: ReturnType<typeof useTaskView>; shown: number }) {
  const { filters: f, setFilter, clear } = view;
  const total = s.tasks.filter((t) => f.archived || (!t.archived_at && !t.cancelled_at)).length;
  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
        <div className="col-span-2 md:w-56">
          <label htmlFor="task-filter" className="sr-only">Filter tasks</label>
          <input id="task-filter" placeholder="Filter tasks" value={f.q} onChange={(e) => setFilter("q", e.target.value)} className={inputClass} />
        </div>
        <Select label="Project" value={f.project} onChange={(v) => setFilter("project", v)} options={s.projects.map((p) => [p.id, p.name])} />
        <Select label="Next owner" value={f.owner} onChange={(v) => setFilter("owner", v)} options={Object.entries(OWNER_LABEL)} />
        <Select label="Agent" value={f.agent} onChange={(v) => setFilter("agent", v)} options={[...Object.entries(AGENT_LABEL), ["manual", "Manual"]]} />
        <Select label="Priority" value={f.priority} onChange={(v) => setFilter("priority", v)} options={Object.entries(PRIORITY_LABEL)} />
        <Select label="Status" value={f.status} onChange={(v) => setFilter("status", v)} options={Object.entries(STATUS_LABEL)} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sub text-muted-foreground">
        <label className="flex min-h-11 items-center gap-2 md:min-h-0">
          <input type="checkbox" checked={f.archived} onChange={(e) => setFilter("archived", e.target.checked)} />
          Show archived and cancelled
        </label>
        <span data-testid="result-count">{shown} of {total} tasks</span>
        {filtersActive(f) && <button onClick={clear} className="min-h-11 font-medium text-accent-foreground underline md:min-h-0">Clear filters</button>}
      </div>
    </div>
  );
}

// ---- card ----

function CardTags({ s, t }: { s: Snapshot; t: Task }) {
  const newResult = hasNewResult(s, t);
  if (!newResult && !isNew(t)) return null;
  return <span className="rounded-sm bg-accent px-1.5 py-0.5 text-label font-medium text-accent-foreground">{newResult ? "New result" : "New"}</span>;
}

export function TaskCardBody({ s, t, dragging }: { s: Snapshot; t: Task; dragging?: boolean }) {
  const project = s.projects.find((p) => p.id === t.project_id);
  const open = s.requests.filter((r) => r.task_id === t.id);
  return (
    <div className={cn("rounded-md border border-border bg-card p-3", dragging && "shadow-lg")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-label text-muted-foreground">
          <span className="font-medium">{taskRef(t.number)}</span><span>·</span><span className="truncate">{project?.name}</span>
          <PriorityTag priority={t.priority} /><CardTags s={s} t={t} />
        </div>
        {!dragging && <MoveMenu task={t} />}
      </div>
      <Link href={`/tasks/${t.number}`} data-task-link={t.number} className="mt-1 block text-dense font-medium break-words hover:underline" onPointerDown={(e) => e.stopPropagation()}>
        {t.title}
      </Link>
      {open[0] && (
        <div className="mt-2 rounded-sm border border-warning-border bg-warning-soft p-2 text-sub">
          <span className="font-medium text-warning">{open.length > 1 ? `${open.length} questions` : "Question"}</span>
          <p className="mt-0.5 line-clamp-2 break-words text-text-secondary">{open[0].question}</p>
        </div>
      )}
      <p className="mt-2 text-sub text-muted-foreground">{secondaryLine(s, t)}</p>
      <div className="mt-2 flex items-center justify-between gap-2 text-label text-muted-foreground">
        <span>Next: {OWNER_LABEL[t.next_owner]}</span>
        <ProviderLabel agent={t.agent} />
      </div>
    </div>
  );
}

function SortableCard({ s, t }: { s: Snapshot; t: Task }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, data: { status: t.status } });
  return (
    <li ref={setNodeRef} data-testid={`card-${t.number}`} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("touch-pan-y", isDragging && "opacity-40")} {...attributes} {...listeners} role="group" aria-label={t.title} aria-roledescription="Draggable task">
      <TaskCardBody s={s} t={t} />
    </li>
  );
}

function Column({ s, status, tasks }: { s: Snapshot; status: TaskStatus; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}`, data: { status } });
  return (
    <section aria-label={STATUS_LABEL[status]} data-testid={`col-${status}`} className="flex w-72 shrink-0 flex-col lg:w-auto lg:min-w-0 lg:flex-1">
      <header className="mb-2 flex items-center gap-2">
        <StatusBadge status={status} />
        <span className="text-sub text-muted-foreground">{tasks.length}</span>
      </header>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className={cn("flex min-h-24 flex-1 flex-col gap-2 rounded-lg p-1", isOver && "bg-accent")}>
          {tasks.map((t) => <SortableCard key={t.id} s={s} t={t} />)}
          {!tasks.length && <li className="px-2 py-4 text-sub text-muted-foreground">No tasks here.</li>}
        </ul>
      </SortableContext>
    </section>
  );
}

function Kanban({ s, tasks }: { s: Snapshot; tasks: Task[] }) {
  const move = useMoveTask();
  const [active, setActive] = useState<Task | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const toast = useToast();
  const qc = useQueryClient();

  const columns = useMemo(() => {
    const by = Object.fromEntries(STATUSES.map((st) => [st, [] as Task[]])) as Record<TaskStatus, Task[]>;
    [...tasks].sort((a, b) => a.sort_order - b.sort_order).forEach((t) => by[t.status].push(t));
    return by;
  }, [tasks]);

  const onEnd = async (e: DragEndEvent) => {
    setActive(null);
    const t = tasks.find((x) => x.id === e.active.id);
    const over = e.over;
    if (!t || !over) return;
    const to = (over.data.current as { status?: TaskStatus; sortable?: unknown } | undefined)?.status;
    if (!to) return;
    const list = columns[to].filter((x) => x.id !== t.id);
    const idx = list.findIndex((x) => x.id === over.id);
    const before = idx >= 0 ? list[idx - 1]?.sort_order : list.at(-1)?.sort_order;
    const after = idx >= 0 ? list[idx]?.sort_order : undefined;
    const sort = before !== undefined && after !== undefined ? (before + after) / 2
      : after !== undefined ? after - 1 : before !== undefined ? before + 1 : Date.now();
    if (to !== t.status) { await move(t, to, sort); return; }
    if (over.id === t.id) return;
    const snap = qc.getQueryData<Snapshot>(["snapshot"]);
    if (snap) qc.setQueryData<Snapshot>(["snapshot"], { ...snap, tasks: snap.tasks.map((x) => (x.id === t.id ? { ...x, sort_order: sort } : x)) });
    const r = await call(() => reorderTaskAction({ id: t.id, sort_order: sort }));
    if (!r.ok) {
      if (snap) qc.setQueryData(["snapshot"], snap);
      toast(r.message);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(e: DragStartEvent) => setActive(tasks.find((t) => t.id === e.active.id) ?? null)}
      onDragCancel={() => setActive(null)}
      onDragEnd={onEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active: a }) => `Picked up ${tasks.find((t) => t.id === a.id)?.title ?? "task"}.`,
          onDragOver: ({ over }) => {
            const st = (over?.data.current as { status?: TaskStatus } | undefined)?.status;
            return st ? `Over ${STATUS_LABEL[st]}.` : undefined;
          },
          onDragEnd: ({ over }) => {
            const st = (over?.data.current as { status?: TaskStatus } | undefined)?.status;
            return st ? `Dropped in ${STATUS_LABEL[st]}.` : "Dropped.";
          },
          onDragCancel: () => "Move cancelled.",
        },
      }}
    >
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:px-0">
        {STATUSES.map((st) => <Column key={st} s={s} status={st} tasks={columns[st]} />)}
      </div>
      <DragOverlay>{active && <TaskCardBody s={s} t={active} dragging />}</DragOverlay>
    </DndContext>
  );
}

// ---- list (PRD 10.3) ----

type SortKey = "title" | "project" | "status" | "owner" | "agent" | "priority" | "updated";
type GroupKey = "none" | "status" | "project";

export function StatusSelect({ task }: { task: Task }) {
  const move = useMoveTask();
  return (
    <select aria-label={`Status of ${taskRef(task.number)}`} value={task.status} onChange={(e) => void move(task, e.target.value as TaskStatus)} className="h-11 max-w-full rounded-sm border border-input bg-card px-2 text-sub md:h-7">
      {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
    </select>
  );
}

function TaskList({ s, tasks }: { s: Snapshot; tasks: Task[] }) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "updated", asc: false });
  const [group, setGroup] = useState<GroupKey>("none");
  const pname = useCallback((id: string) => s.projects.find((p) => p.id === id)?.name ?? "", [s.projects]);

  const sorted = useMemo(() => {
    const val = (t: Task): string | number => {
      switch (sort.key) {
        case "title": return t.title.toLowerCase();
        case "project": return pname(t.project_id);
        case "status": return STATUSES.indexOf(t.status);
        case "owner": return t.next_owner;
        case "agent": return t.agent ?? "";
        case "priority": return ["low", "normal", "high", "urgent"].indexOf(t.priority);
        case "updated": return t.updated_at;
      }
    };
    return [...tasks].sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.asc ? 1 : -1);
    });
  }, [tasks, sort, pname]);

  const groups = useMemo(() => {
    if (group === "none") return [{ key: "all", label: "", rows: sorted }];
    const keys = group === "status" ? STATUSES.map((x) => [x, STATUS_LABEL[x]] as const) : s.projects.map((p) => [p.id, p.name] as const);
    return keys.map(([key, label]) => ({ key, label, rows: sorted.filter((t) => (group === "status" ? t.status : t.project_id) === key) })).filter((g) => g.rows.length);
  }, [group, sorted, s.projects]);

  const head = (k: SortKey, label: string) => (
    <th key={k} scope="col" aria-sort={sort.key === k ? (sort.asc ? "ascending" : "descending") : "none"} className="px-3 py-2 text-left text-label font-medium text-muted-foreground">
      <button className="inline-flex items-center gap-1" onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : true })}>
        {label}{sort.key === k && (sort.asc ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
      </button>
    </th>
  );

  return (
    <div>
      <label className="mb-2 flex items-center gap-2 text-sub text-muted-foreground">
        Group by
        <select value={group} onChange={(e) => setGroup(e.target.value as GroupKey)} className="h-11 rounded-sm border border-input bg-card px-2 md:h-7">
          <option value="none">None</option><option value="status">Status</option><option value="project">Project</option>
        </select>
      </label>
      {/* Phone: stacked rows. The table needs more width than a phone has. */}
      <div className="flex flex-col gap-4 md:hidden">
        {groups.map((g) => (
          <section key={g.key}>
            {g.label && <h2 className="mb-2 text-sub font-semibold">{g.label}</h2>}
            <ul className="flex flex-col gap-2">
              {g.rows.map((t) => (
                <li key={t.id} data-testid={`row-${t.number}`} className="rounded-md border border-border bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-label text-muted-foreground">{taskRef(t.number)} · {pname(t.project_id)}</p>
                      <Link href={`/tasks/${t.number}`} data-task-link={t.number} className="flex min-h-11 items-center text-dense font-medium break-words">{t.title}</Link>
                    </div>
                    <PriorityTag priority={t.priority} />
                  </div>
                  <p className="text-sub text-muted-foreground">{secondaryLine(s, t)}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <StatusSelect task={t} />
                    <span className="text-label text-muted-foreground">Next: {OWNER_LABEL[t.next_owner]} · <RelTime iso={t.updated_at} /></span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
        <table className="w-full border-collapse text-dense">
          <thead>
            <tr className="border-b border-border">
              {head("title", "Title")}{head("project", "Project")}{head("status", "Status")}{head("owner", "Next owner")}
              {head("agent", "Agent")}{head("priority", "Priority")}{head("updated", "Updated")}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key}>
              {g.label && <tr><th colSpan={7} scope="colgroup" className="bg-muted px-3 py-1.5 text-left text-sub font-semibold">{g.label}</th></tr>}
              {g.rows.map((t) => (
                <tr key={t.id} data-testid={`row-${t.number}`} className="border-b border-border last:border-0">
                  <td className="max-w-96 px-3 py-2">
                    <Link href={`/tasks/${t.number}`} data-task-link={t.number} className="font-medium break-words hover:underline">{t.title}</Link>
                    <p className="text-sub text-muted-foreground">{taskRef(t.number)} · {secondaryLine(s, t)}</p>
                  </td>
                  <td className="px-3 py-2">{pname(t.project_id)}</td>
                  <td className="px-3 py-2"><StatusSelect task={t} /></td>
                  <td className="px-3 py-2">{OWNER_LABEL[t.next_owner]}</td>
                  <td className="px-3 py-2"><ProviderLabel agent={t.agent} /></td>
                  <td className="px-3 py-2">{PRIORITY_LABEL[t.priority]}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground"><RelTime iso={t.updated_at} /></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

// ---- page ----

export function TasksScreen() {
  const { data: s } = useSnapshot();
  const view = useTaskView();
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 767px)");
    const on = () => setMobile(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  if (!s) return <PageSkeleton />;
  const mode = view.view ?? (mobile ? "list" : "kanban");
  const pname = (id: string) => s.projects.find((p) => p.id === id)?.name ?? "";
  const shown = applyFilters(s.tasks, view.filters, pname);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <div role="group" aria-label="View" className="inline-flex rounded-md border border-border bg-card p-0.5">
          {([["kanban", "Kanban", Columns3], ["list", "List", List]] as const).map(([v, l, Icon]) => (
            <button key={v} aria-pressed={mode === v} onClick={() => view.setView(v)} className={cn("flex h-11 items-center gap-1 rounded-sm px-3 text-sub md:h-7", mode === v && "bg-accent font-medium text-accent-foreground")}>
              <Icon size={14} aria-hidden />{l}
            </button>
          ))}
        </div>
      </div>
      <FilterBar s={s} view={view} shown={shown.length} />
      {!shown.length && s.tasks.length > 0 ? (
        <EmptyState title="No tasks match these filters"><Button variant="secondary" onClick={view.clear} className="mt-2">Clear filters</Button></EmptyState>
      ) : mode === "kanban" ? <Kanban s={s} tasks={shown} /> : <TaskList s={s} tasks={shown} />}
    </div>
  );
}
