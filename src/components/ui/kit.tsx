"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Terminal } from "lucide-react";
import type { AgentKind, CheckState, Priority, RunState, TaskStatus } from "@/lib/domain/types";
import { AGENT_LABEL, ago, PRIORITY_LABEL, RUN_LABEL, STATUS_LABEL } from "@/lib/view";
import { useSnapshot } from "@/components/providers";
import { cn } from "@/lib/utils";

export const inputClass = "h-11 w-full rounded-sm border border-input bg-card px-3 text-base text-foreground md:h-[34px] disabled:opacity-60";
export const textareaClass = "w-full rounded-sm border border-input bg-card px-3 py-2 text-base leading-relaxed text-foreground";
export const labelClass = "text-sub font-medium text-text-secondary";

const STATUS_STYLE: Record<TaskStatus, string> = {
  inbox: "bg-status-inbox-bg text-status-inbox-fg",
  ai_queue: "bg-status-queue-bg text-status-queue-fg",
  in_progress: "bg-status-progress-bg text-status-progress-fg",
  needs_denny: "bg-status-needs-bg text-status-needs-fg",
  review: "bg-status-review-bg text-status-review-fg",
  done: "bg-status-done-bg text-status-done-fg",
};

function StatusGlyph({ status }: { status: TaskStatus }) {
  const common = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: 1.5 };
  switch (status) {
    case "inbox": return <svg {...common}><circle cx="6" cy="6" r="4.5" strokeDasharray="2 1.6" /></svg>;
    case "ai_queue": return <svg {...common}><circle cx="6" cy="6" r="4.5" /><path d="M6 1.5V4" /></svg>;
    case "in_progress": return <svg {...common}><circle cx="6" cy="6" r="4.5" /><path d="M6 1.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" stroke="none" /></svg>;
    case "needs_denny": return <svg {...common}><path d="M6 .8 11.2 6 6 11.2.8 6z" fill="currentColor" stroke="none" /></svg>;
    case "review": return <svg {...common}><circle cx="6" cy="6" r="4.5" /><circle cx="6" cy="6" r="1.6" fill="currentColor" stroke="none" /></svg>;
    case "done": return <svg {...common}><circle cx="6" cy="6" r="5.5" fill="currentColor" stroke="none" /><path d="m3.5 6.2 1.7 1.7 3.3-3.6" stroke="white" /></svg>;
  }
}

const chip = "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-label font-medium whitespace-nowrap";

export const StatusBadge = ({ status }: { status: TaskStatus }) => (
  <span className={cn(chip, STATUS_STYLE[status])}><StatusGlyph status={status} />{STATUS_LABEL[status]}</span>
);

const RUN_STYLE: Partial<Record<RunState, string>> = {
  running: "bg-status-progress-bg text-status-progress-fg",
  waiting_for_input: "bg-warning-tint text-warning",
  interrupted: "bg-warning-tint text-warning",
  failed: "bg-danger-tint text-danger",
  completed: "bg-success-tint text-success",
};
export const RunStateBadge = ({ state }: { state: RunState }) => (
  <span className={cn(chip, RUN_STYLE[state] ?? "bg-status-inbox-bg text-status-inbox-fg")}>{RUN_LABEL[state]}</span>
);

const CHECK: Record<CheckState, { glyph: string; label: string; cls: string }> = {
  passed: { glyph: "✓", label: "Passed", cls: "bg-success-tint text-success" },
  failed: { glyph: "×", label: "Failed", cls: "bg-danger-tint text-danger" },
  not_run: { glyph: "–", label: "Not run", cls: "bg-status-inbox-bg text-status-inbox-fg" },
  unknown: { glyph: "?", label: "Unknown", cls: "bg-status-inbox-bg text-status-inbox-fg" },
};
export const CheckChip = ({ state, prefix }: { state: CheckState; prefix?: string }) => (
  <span className={cn(chip, CHECK[state].cls)}><span aria-hidden>{CHECK[state].glyph}</span>{prefix}{CHECK[state].label}</span>
);

export const ReasonChip = ({ children }: { children: ReactNode }) => (
  <span className={cn(chip, "bg-warning-tint text-warning")}>{children}</span>
);

export const PriorityTag = ({ priority }: { priority: Priority }) =>
  priority === "high" || priority === "urgent" ? (
    <span className={cn(chip, priority === "urgent" ? "bg-danger-tint text-danger" : "bg-warning-tint text-warning")}>{PRIORITY_LABEL[priority]}</span>
  ) : null;

export const ProviderLabel = ({ agent }: { agent: AgentKind | null }) =>
  agent ? (
    <span className="inline-flex items-center gap-1 text-label text-muted-foreground"><Terminal size={12} aria-hidden />{AGENT_LABEL[agent]}</span>
  ) : (
    <span className="text-label text-muted-foreground">Manual</span>
  );

export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="rounded-lg border border-dashed border-border-strong bg-card px-6 py-8 text-center">
    <p className="text-section font-medium">{title}</p>
    {children && <div className="mt-2 text-dense text-muted-foreground">{children}</div>}
  </div>
);

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn("rounded-md bg-border", className)} />;
export const PageSkeleton = () => (
  <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
    <Skeleton className="h-6 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-2/3" />
  </div>
);

export function useFormatAbs() {
  const { data } = useSnapshot();
  const tz = data?.settings?.timezone;
  return (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", ...(tz && tz !== "device" ? { timeZone: tz } : {}) }).format(new Date(iso));
}

/** Relative time; the absolute time is in title and, for touch, available in details views. */
export function RelTime({ iso }: { iso: string }) {
  const abs = useFormatAbs();
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setLabel(ago(iso));
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 60_000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [iso]);
  return <time dateTime={iso} title={label ? abs(iso) : undefined} suppressHydrationWarning>{label ?? ""}</time>;
}
