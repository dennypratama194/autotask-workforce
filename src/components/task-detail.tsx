"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowLeft, ChevronRight, ExternalLink, Link2, MoreHorizontal, Paperclip, X } from "lucide-react";
import type { Attachment, Artifact, InputRequest, Run, TaskDetail } from "@/lib/domain/types";
import { CHANGES_ERROR, CHANGES_MIN, isActive, isExecuting, taskRef, validateAnswer } from "@/lib/domain/rules";
import { AGENT_LABEL, ago, checkSummary, RUN_LABEL, REASON_LABEL, SOURCE_LABEL, STEP_LABELS } from "@/lib/view";
import {
  acceptCriterionAction, addCriterionAction, answerAction, approveAction, archiveTaskAction, cancelTaskAction, newRunAction,
  requestChangesAction, sendMessageAction, stopRunAction, takeOverAction, updateTaskAction,
} from "@/app/actions";
import { call, useBlocked, useRefresh, useSnapshot, useTaskDetail, useToast } from "@/components/providers";
import { useOnline } from "@/components/shell";
import { StatusSelect } from "@/components/tasks";
import { Button } from "@/components/ui/button";
import { CheckChip, inputClass, labelClass, PageSkeleton, ReasonChip, RelTime, RunStateBadge, Skeleton, textareaClass, useFormatAbs } from "@/components/ui/kit";
import { cn } from "@/lib/utils";

type Upload = { key: string; file: File; state: "uploading" | "ready" | "error"; path?: string };
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

// ---- attachments ----

function useUploads(taskId: string) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const upload = async (u: Upload) => {
    setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, state: "uploading" } : x)));
    const path = `${taskId}/${u.key}-${u.file.name.replace(/[^\w.-]+/g, "_")}`;
    let ok = true;
    if (process.env.NEXT_PUBLIC_E2E !== "1") {
      try {
        const sb = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
        const { error } = await sb.storage.from("attachments").upload(path, u.file);
        ok = !error;
      } catch { ok = false; }
    }
    setUploads((l) => l.map((x) => (x.key === u.key ? { ...x, state: ok ? "ready" : "error", path } : x)));
  };
  return {
    uploads,
    add: (files: FileList | null) => {
      for (const file of Array.from(files ?? [])) {
        const u: Upload = { key: crypto.randomUUID(), file, state: "uploading" };
        setUploads((l) => [...l, u]);
        void upload(u);
      }
    },
    retry: (u: Upload) => void upload(u),
    remove: (key: string) => setUploads((l) => l.filter((x) => x.key !== key)),
    clear: () => setUploads([]),
    busy: uploads.some((u) => u.state === "uploading"),
    payload: () => uploads.filter((u) => u.state === "ready" && u.path).map((u) => ({ storage_path: u.path!, file_name: u.file.name, size_bytes: u.file.size, mime: u.file.type || null })),
  };
}

function AttachControl({ u }: { u: ReturnType<typeof useUploads> }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input ref={ref} type="file" multiple className="sr-only" aria-label="Attach files" onChange={(e) => { u.add(e.target.files); e.target.value = ""; }} />
      <Button type="button" variant="secondary" size="sm" className="h-11 md:h-7" onClick={() => ref.current?.click()}><Paperclip size={14} aria-hidden />Attach file</Button>
      {u.uploads.map((x) => (
        <span key={x.key} className={cn("inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-sub", x.state === "error" ? "border-danger text-danger" : "border-border")}>
          <span className="max-w-40 truncate">{x.file.name}</span> · {x.state === "uploading" ? "Uploading" : x.state === "ready" ? "Ready" : "Upload failed"}
          {x.state === "error" && <button type="button" className="underline" onClick={() => u.retry(x)}>Retry</button>}
          <button type="button" aria-label={`Remove ${x.file.name}`} className="underline" onClick={() => u.remove(x.key)}>Remove</button>
        </span>
      ))}
    </div>
  );
}

const AttachmentLinks = ({ list }: { list: Attachment[] }) => !list.length ? null : (
  <ul className="mt-2 flex flex-wrap gap-2">
    {list.map((a) => <li key={a.id}>{a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="rounded-sm border border-border px-2 py-1 text-sub underline">{a.file_name}</a> : <span className="rounded-sm border border-border px-2 py-1 text-sub">{a.file_name}</span>}</li>)}
  </ul>
);

// ---- request cards (PRD 7.3) ----

function RequestCard({ r, index, total }: { r: InputRequest; index: number; total: number }) {
  const toast = useToast();
  const refresh = useRefresh();
  const u = useUploads(r.task_id);
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errId = `err-${r.id}`;

  const submit = async () => {
    const attachments = u.payload();
    const err = validateAnswer(r.kind, r.choices.length, { choice, text, confirmed, hasFile: !!attachments.length });
    if (err) { setError(err); return; }
    setBusy(true); setError(null);
    const res = await call(() => answerAction({ request_id: r.id, choice, text: text || null, note: note || null, confirmed, attachments }));
    setBusy(false);
    if (!res.ok) { setError(res.network ? "Not sent. Check your connection and try again." : res.message); return; }
    toast(res.data.message);
    void refresh();
  };

  return (
    <section id={`request-${r.id}`} data-testid="request-card" aria-label={`Request: ${r.question}`} className="scroll-mt-20 rounded-lg border border-warning-border bg-warning-soft p-4">
      <div className="flex flex-wrap items-center gap-2 text-sub">
        <span className="font-semibold text-warning">Needs your answer{total > 1 ? ` · ${index + 1} of ${total}` : ""}</span>
        <ReasonChip>{REASON_LABEL[r.reason]}</ReasonChip>
        <span className="text-muted-foreground"><RelTime iso={r.created_at} /> · {r.asked_by}</span>
      </div>
      <h3 className="mt-2 text-section font-semibold break-words">{r.question}</h3>
      {r.context && <p className="mt-1 text-dense break-words whitespace-pre-wrap text-text-secondary">{r.context}</p>}
      {r.blocks && <p className="mt-1 text-sub break-words text-muted-foreground">Blocks: {r.blocks}</p>}
      <form className="mt-3 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {r.kind === "choice" && (
          <fieldset aria-describedby={error ? errId : undefined}><legend className="sr-only">Choose one</legend>
            {r.choices.map((c, i) => (
              <label key={c} className="flex min-h-11 items-center gap-2 text-dense">
                <input type="radio" name={`choice-${r.id}`} checked={choice === i} onChange={() => setChoice(i)} /> <span className="break-words">{c}</span>
              </label>
            ))}
          </fieldset>
        )}
        {(r.kind === "text" || r.kind === "asset") && (
          <label className="flex flex-col gap-1"><span className={labelClass}>{r.kind === "text" ? "Your answer" : "Where to find it (or attach below)"}</span>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className={textareaClass} aria-describedby={error ? errId : undefined} /></label>
        )}
        {r.kind === "asset" && <AttachControl u={u} />}
        {r.kind === "action" && (
          <label className="flex min-h-11 items-center gap-2 text-dense"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I&apos;ve done this</label>
        )}
        <label className="flex flex-col gap-1"><span className={labelClass}>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} /></label>
        {error && <p id={errId} role="alert" className="text-dense text-danger">{error}</p>}
        <div><Button type="submit" disabled={busy || u.busy} className="h-11 w-full md:h-[34px] md:w-auto">Answer and Resume</Button></div>
      </form>
    </section>
  );
}

// ---- run banner (PRD 10.6) ----

function StepChips({ run }: { run: Run }) {
  return (
    <ol aria-label="Run steps" className="flex flex-wrap gap-1">
      {STEP_LABELS.map((l, i) => (
        <li key={l} aria-current={i === run.step ? "step" : undefined} className={cn("rounded-sm px-2 py-0.5 text-label", i === run.step ? "bg-status-progress-bg font-medium text-status-progress-fg" : i < run.step ? "bg-success-tint text-success" : "bg-status-inbox-bg text-status-inbox-fg")}>{l}</li>
      ))}
    </ol>
  );
}

function RunBanner({ d, openResults }: { d: TaskDetail; openResults: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const { setBlocked } = useBlocked();
  const { data: snap } = useSnapshot();
  const run = d.runs[0];
  if (!run) return null;
  const doAct = async (fn: () => ReturnType<typeof stopRunAction>) => {
    const r = await call(fn);
    if (!r.ok) {
      if (r.blocked) setBlocked({ title: r.message, reasons: r.blocked, projectSlug: d.project.slug, taskNumber: d.task.number });
      else toast(r.message);
    } else toast(r.data.message);
    void refresh();
  };
  const stop = () => doAct(() => stopRunAction({ id: d.task.id }));
  const retry = () => doAct(() => newRunAction({ id: d.task.id, kind: "retry" }));
  const retryBtn = <Button variant="secondary" className="h-11 md:h-[34px]" disabled={d.runs.some((r) => isActive(r.state))} onClick={retry}>Retry as new run</Button>;
  const details = <Button variant="ghost" className="h-11 md:h-[34px]" onClick={openResults}>Run details</Button>;
  const worker = d.workers.find((w) => w.id === run.worker_id);
  const wrap = (cls: string, title: string, body: React.ReactNode, actions?: React.ReactNode) => (
    <section data-testid="run-banner" aria-label="Run status" className={cn("rounded-lg border p-4", cls)}>
      <div className="flex flex-wrap items-center gap-2"><RunStateBadge state={run.state} /><p className="text-dense font-medium break-words">{title}</p></div>
      {body && <div className="mt-2 text-sub text-text-secondary">{body}</div>}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </section>
  );
  const neutral = "border-border bg-card";
  const warn = "border-warning-border bg-warning-soft";
  const queueWhy = snap ? (() => {
    const w = snap.workers.find((x) => x.id === run.worker_id);
    return w?.state === "offline" ? `Worker offline · last seen ${ago(w.last_seen_at)}` : `Waiting for ${w?.name ?? "a worker"}`;
  })() : "";
  const pauseOff = <Button variant="secondary" disabled title="Pause isn't supported by this agent yet. Stop is available." className="h-11 md:h-[34px]">Pause</Button>;

  switch (run.state) {
    case "queued":
      return wrap(neutral, `Run ${run.attempt} is queued`, queueWhy, <Button variant="secondary" className="h-11 md:h-[34px]" onClick={stop}>Remove from queue</Button>);
    case "running":
      return wrap(neutral, `Run ${run.attempt} · ${worker?.name ?? "External session"}`, <>
        <StepChips run={run} />
        {run.note && <p className="mt-2 break-words">Last update: {run.note}</p>}
        <p className="mt-1 text-muted-foreground">Pause isn&apos;t supported by this agent yet. Stop is available.</p>
      </>, <>{pauseOff}<Button variant="destructive" className="h-11 md:h-[34px]" onClick={stop}>Stop</Button></>);
    case "pausing": case "paused":
      return wrap(neutral, RUN_LABEL[run.state], null, <Button variant="destructive" className="h-11 md:h-[34px]" onClick={stop}>Stop</Button>);
    case "stopping":
      return wrap(warn, `Stop requested. Waiting for ${worker?.name ?? "the worker"} to confirm. Stop doesn't revert files.`, null);
    case "waiting_for_input":
      return wrap(warn, `Run ${run.attempt} is waiting for your answer`, "The answer below resumes the work.");
    case "interrupted":
      return wrap(warn, run.wait_reason ?? "Agent stalled", run.end_note, <>{retryBtn}<Button variant="ghost" className="h-11 md:h-[34px]" onClick={() => doAct(async () => { const r = await takeOverAction({ id: d.task.id }); return r.ok ? { ok: true, data: { message: "You own this task now." } } : r; })}>Take over</Button>{details}</>);
    case "failed": {
      const authProblem = /auth|login|token|credential/i.test(run.error_summary ?? "");
      return wrap("border-danger bg-danger-tint", `Run ${run.attempt} failed`, <>
        <p className="break-words">{run.error_summary}</p>
        {run.last_meaningful_step && <p className="mt-1 break-words">Last step: {run.last_meaningful_step}</p>}
        {run.suggested_action && <p className="mt-1 break-words">Suggested: {run.suggested_action}</p>}
      </>, <>{retryBtn}{authProblem && <Button variant="secondary" asChild className="h-11 md:h-[34px]"><Link href="/settings?section=workers">Fix connection</Link></Button>}{details}</>);
    }
    case "cancelled":
      return wrap(neutral, `Run ${run.attempt} stopped`, run.end_note, <Button variant="secondary" className="h-11 md:h-[34px]" onClick={() => doAct(() => newRunAction({ id: d.task.id, kind: "initial" }))}>Start a new run</Button>);
    default:
      return null;
  }
}

// ---- conversation ----

type Unsent = { client_id: string; mode: "comment" | "instruction"; body: string };
type Mode = "comment" | "instruction" | "answer";

function Composer({ d, onAnswerMode }: { d: TaskDetail; onAnswerMode: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const online = useOnline();
  const { setBlocked } = useBlocked();
  const u = useUploads(d.task.id);
  const key = `tw:draft:${d.task.id}`;
  const unsentKey = `tw:unsent:${d.task.id}`;
  const hasOpen = d.requests.some((r) => r.state === "open");
  const active = d.runs.some((r) => isActive(r.state));
  const [mode, setMode] = useState<Mode>("comment");
  const [body, setBody] = useState("");
  const [unsent, setUnsent] = useState<Unsent[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // localStorage is unavailable during server render, so drafts load after mount.
    /* eslint-disable react-hooks/set-state-in-effect */
    setBody(store.get(key) ?? "");
    try { setUnsent(JSON.parse(store.get(unsentKey) ?? "[]")); } catch { setUnsent([]); }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [key, unsentKey]);

  const saveUnsent = (l: Unsent[]) => { setUnsent(l); if (l.length) store.set(unsentKey, JSON.stringify(l)); else store.del(unsentKey); };

  const send = async (m: Unsent) => {
    const r = await call(() => sendMessageAction({ task_id: d.task.id, mode: m.mode, body: m.body, client_id: m.client_id, attachments: u.payload() }));
    if (!r.ok) {
      if (r.network) return "network" as const;
      toast(r.message);
      return "error" as const;
    }
    toast(r.data.message);
    if (r.data.blocked?.length) setBlocked({ title: r.data.message, reasons: r.data.blocked, projectSlug: d.project.slug, taskNumber: d.task.number });
    void refresh();
    return "ok" as const;
  };

  const submit = async () => {
    if (mode === "answer") { onAnswerMode(); return; }
    if (!body.trim() && !u.uploads.length) return;
    const m: Unsent = { client_id: crypto.randomUUID(), mode, body };
    setBusy(true);
    const outcome = online ? await send(m) : "network";
    setBusy(false);
    if (outcome === "error") return;
    if (outcome === "network") saveUnsent([...unsent, m]);
    setBody(""); store.del(key); u.clear();
  };

  const label = mode === "comment" ? "Comment" : mode === "answer" ? "Answer and Resume" : active ? "Save for next run" : "Send to AI";
  const help = mode === "comment" ? "Adds a note to this task. Nothing runs."
    : mode === "answer" ? "Answer in the request card above. It resumes the work."
    : active ? "Saved for the next run. The running agent won't receive it." : "Saves the instruction and queues a run if the prerequisites pass.";
  const modes: [Mode, string][] = [["comment", "Comment"], ["instruction", "Send to AI"], ...(hasOpen ? [["answer", "Answer and Resume"] as [Mode, string]] : [])];

  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-card p-3 pb-[max(12px,env(safe-area-inset-bottom))] md:static md:mx-0 md:rounded-lg md:border">
      {unsent.map((m) => (
        <div key={m.client_id} className="mb-2 rounded-sm border border-danger bg-danger-tint p-2 text-sub">
          <p className="break-words whitespace-pre-wrap">{m.body}</p>
          <p className="mt-1 font-medium text-danger">Not sent
            <button className="ml-2 underline" onClick={async () => { if ((await send(m)) !== "network") saveUnsent(unsent.filter((x) => x.client_id !== m.client_id)); }}>Retry send</button>
          </p>
        </div>
      ))}
      <div role="group" aria-label="Message type" className="mb-2 inline-flex flex-wrap rounded-md border border-border p-0.5">
        {modes.map(([m, l]) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn("min-h-11 rounded-sm px-3 text-sub md:min-h-7", mode === m && "bg-accent font-medium text-accent-foreground")}>{l}</button>
        ))}
      </div>
      <label className="block"><span className="sr-only">Message</span>
        <textarea rows={2} value={body} disabled={mode === "answer"} onChange={(e) => { setBody(e.target.value); store.set(key, e.target.value); }}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }} className={textareaClass} /></label>
      <p className="mt-1 text-sub text-muted-foreground">{help}</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {mode !== "answer" ? <AttachControl u={u} /> : <span />}
        <Button disabled={busy || u.busy} onClick={() => void submit()} className="h-11 md:h-[34px]">{label}</Button>
      </div>
    </div>
  );
}

const KIND_TAG: Record<string, string> = { comment: "Comment", instruction: "Instruction", answer: "Answer", update: "Update", question: "Question", result: "Result", system: "System" };

function MessageList({ d }: { d: TaskDetail }) {
  const runNumber = (id: string | null) => d.runs.find((r) => r.id === id)?.attempt;
  if (!d.messages.length) return <p className="text-dense text-muted-foreground">No messages yet.</p>;
  return (
    <ol className="flex flex-col gap-3">
      {d.messages.map((m) => {
        const who = m.author === "denny" ? "Denny" : m.author === "system" ? "System" : m.agent ? AGENT_LABEL[m.agent] : "Agent";
        return (
          <li key={m.id} data-testid="message" className="flex gap-2">
            <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-sm bg-accent text-label font-semibold text-accent-foreground">{who[0]}</span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 text-sub text-muted-foreground"><span className="font-medium text-foreground">{who}</span><span>{KIND_TAG[m.kind]}</span><RelTime iso={m.created_at} /></p>
              <p className="text-dense break-words whitespace-pre-wrap">{m.body}</p>
              <AttachmentLinks list={d.attachments.filter((a) => a.message_id === m.id)} />
              {m.pending_for_next_run && <p className="mt-1 text-sub text-warning">Pending: saved for the next run. The running agent hasn&apos;t received it.</p>}
              {m.delivered_run_id && <p className="mt-1 text-sub text-success">Included in run {runNumber(m.delivered_run_id)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function BriefBlock({ d }: { d: TaskDetail }) {
  const toast = useToast();
  const refresh = useRefresh();
  const abs = useFormatAbs();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.task.brief);
  const active = d.runs.find((r) => isActive(r.state));
  const edit = d.activity.find((a) => a.action === "brief_edited");
  return (
    <section aria-label="Brief">
      <div className="flex items-center justify-between"><h3 className="text-section font-semibold">Brief</h3>
        {!editing && <Button variant="ghost" size="sm" className="h-11 md:h-7" onClick={() => { setText(d.task.brief); setEditing(true); }}>Edit</Button>}</div>
      {editing ? (
        <form className="mt-1 flex flex-col gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const r = await call(() => updateTaskAction({ id: d.task.id, patch: { brief: text } }));
          if (!r.ok) { toast(r.message); return; }
          setEditing(false); void refresh();
        }}>
          <label><span className="sr-only">Brief</span><textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} className={textareaClass} /></label>
          <div className="flex gap-2"><Button type="submit" className="h-11 md:h-[34px]">Save brief</Button><Button type="button" variant="ghost" className="h-11 md:h-[34px]" onClick={() => setEditing(false)}>Discard</Button></div>
        </form>
      ) : <p className="mt-1 text-dense break-words whitespace-pre-wrap">{d.task.brief || "No brief yet."}</p>}
      {d.task.reference_url && <a href={d.task.reference_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sub break-all underline"><Link2 size={12} aria-hidden />{d.task.reference_url}</a>}
      {d.task.brief_changed_during_run && active && edit && (
        <p className="mt-2 rounded-sm bg-warning-tint p-2 text-sub text-warning">Brief edited after run {active.attempt} started at {abs(edit.at)}. Run {active.attempt} keeps the snapshot from then; your edits apply to the next run.</p>
      )}
    </section>
  );
}

function Criteria({ d }: { d: TaskDetail }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [text, setText] = useState("");
  return (
    <section aria-label="Acceptance criteria">
      <h3 className="text-section font-semibold">Acceptance criteria</h3>
      <ul className="mt-1 flex flex-col gap-2">
        {d.criteria.map((c) => (
          <li key={c.id} className="rounded-md border border-border bg-card p-2">
            <p className="text-dense break-words">{c.text}</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <CheckChip state={c.agent_state} prefix="Agent: " />
              <label className="flex min-h-11 items-center gap-2 text-sub md:min-h-0">
                <input type="checkbox" checked={c.accepted} onChange={async (e) => { const accepted = e.target.checked; const r = await call(() => acceptCriterionAction({ id: c.id, accepted })); if (!r.ok) toast(r.message); void refresh(); }} />
                Accepted by Denny
              </label>
            </div>
          </li>
        ))}
      </ul>
      <form className="mt-2 flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        const r = await call(() => addCriterionAction({ id: d.task.id, text }));
        if (!r.ok) { toast(r.message); return; }
        setText(""); void refresh();
      }}>
        <label className="flex-1"><span className="sr-only">Add criterion</span><input placeholder="Add criterion" value={text} onChange={(e) => setText(e.target.value)} className={inputClass} /></label>
        <Button type="submit" variant="secondary" className="h-11 md:h-[34px]">Add</Button>
      </form>
    </section>
  );
}

// ---- results (PRD 7.4) ----

function ArtifactTile({ a }: { a: Artifact }) {
  const [open, setOpen] = useState(false);
  const label = <><span className="text-label font-medium text-muted-foreground uppercase">{a.kind.replace("_", " ")}</span><span className="block text-dense font-medium break-words">{a.label}</span></>;
  const issue = a.issue && <span className="mt-1 block text-sub text-warning">{a.issue}</span>;
  const cls = "block min-h-11 w-full rounded-md border border-border bg-card p-2 text-left hover:bg-muted";
  if (a.kind === "screenshot" && a.url) {
    return (
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger className={cls}>{label}{issue}</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/80" />
          <Dialog.Content aria-describedby={undefined} className="fixed inset-4 z-50 grid place-items-center">
            <Dialog.Title className="sr-only">{a.label}</Dialog.Title>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.label} className="max-h-full max-w-full rounded-md" />
            <Dialog.Close aria-label="Close" className="absolute top-0 right-0 grid size-11 place-items-center rounded-md bg-card"><X size={16} aria-hidden /></Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return a.url ? <a href={a.url} target="_blank" rel="noreferrer" className={cls}>{label}{issue}</a> : <div className={cls}>{label}{issue}</div>;
}

function ReviewBar({ d, prNumber }: { d: TaskDetail; prNumber: string | null }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const clientId = useRef<string | null>(null);
  return (
    <section data-testid="review-bar" aria-label="Review" className="rounded-lg border border-border bg-card p-4">
      <p className="text-sub text-text-secondary">Approving accepts the task outcome and moves it to Done. It doesn&apos;t merge {prNumber ?? "any PR"} or deploy anything. Merge and deploy are separate actions that need their own permissions and aren&apos;t enabled for this project.</p>
      {changing ? (
        <form className="mt-3 flex flex-col gap-2" onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim().length < CHANGES_MIN) { setError(CHANGES_ERROR); return; }
          clientId.current ??= crypto.randomUUID();
          const r = await call(() => requestChangesAction({ id: d.task.id, text, client_id: clientId.current! }));
          if (!r.ok) { setError(r.message); return; }
          toast(r.data.message); setChanging(false); setText(""); clientId.current = null; void refresh();
        }}>
          <label className="flex flex-col gap-1"><span className={labelClass}>What should change?</span>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className={textareaClass} /></label>
          {error && <p role="alert" className="text-dense text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2"><Button type="submit" className="h-11 md:h-[34px]">Request changes and queue run</Button><Button type="button" variant="ghost" className="h-11 md:h-[34px]" onClick={() => setChanging(false)}>Cancel</Button></div>
        </form>
      ) : (
        <div className="mt-3 flex flex-col gap-2 md:flex-row">
          <Button className="h-11 md:h-[34px]" onClick={async () => { const r = await call(() => approveAction({ id: d.task.id })); if (!r.ok) toast(r.message); else toast("Outcome accepted. The task is Done."); void refresh(); }}>Approve completion</Button>
          <Button variant="secondary" className="h-11 md:h-[34px]" onClick={() => setChanging(true)}>Request changes</Button>
        </div>
      )}
    </section>
  );
}

function RunHistoryItem({ d, run }: { d: TaskDetail; run: Run }) {
  const abs = useFormatAbs();
  const worker = d.workers.find((w) => w.id === run.worker_id);
  const events = d.events.filter((e) => e.run_id === run.id);
  const checks = d.checks.filter((c) => c.run_id === run.id);
  const duration = run.started_at && run.ended_at ? `${Math.max(1, Math.round((new Date(run.ended_at).getTime() - new Date(run.started_at).getTime()) / 60000))} min` : "–";
  return (
    <details data-testid="run-history" className="group rounded-md border border-border bg-card">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 p-2 text-dense">
        <ChevronRight size={14} aria-hidden className="group-open:rotate-90" />
        <span className="font-medium">Run {run.attempt}</span><RunStateBadge state={run.state} /><span className="text-sub text-muted-foreground capitalize">{run.kind} · {AGENT_LABEL[run.agent]}</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-border p-3 text-sub">
        <p className="break-words">{worker?.name ?? (run.worker_id ? "Removed worker" : "External session")} · Started {run.started_at ? abs(run.started_at) : "not yet"} · Duration {duration}</p>
        <p>Usage: {run.usage ? JSON.stringify(run.usage) : "Not available"}</p>
        {run.note && <p className="break-words">Last update: {run.note}</p>}
        <StepChips run={run} />
        {run.error_summary && <div className="rounded-sm bg-danger-tint p-2"><p className="break-words text-danger">{run.error_summary}</p>{run.last_meaningful_step && <p className="break-words">Last step: {run.last_meaningful_step}</p>}{run.partial_output && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words">{run.partial_output}</pre>}{run.suggested_action && <p className="break-words">Suggested: {run.suggested_action}</p>}</div>}
        {run.end_note && <p className="break-words">{run.end_note}</p>}
        {!!checks.length && <ul className="flex flex-wrap gap-1">{checks.map((c) => <li key={c.id} className="inline-flex items-center gap-1"><span>{c.name}</span><CheckChip state={c.state} /></li>)}</ul>}
        <details><summary className="min-h-11 cursor-pointer font-medium md:min-h-0">Technical log ({events.length})</summary>
          <ol className="mt-1 flex flex-col gap-1 font-mono text-label">{events.map((e) => <li key={e.id} className="break-words"><span className="text-muted-foreground">{abs(e.at)}</span> {e.text}</li>)}</ol>
        </details>
      </div>
    </details>
  );
}

function ResultsTab({ d }: { d: TaskDetail }) {
  const abs = useFormatAbs();
  const activeRun = d.runs.some((r) => isActive(r.state));
  const results = [...d.results].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = results[0];
  const run = latest && d.runs.find((r) => r.id === latest.run_id);
  const artifacts = latest ? d.artifacts.filter((a) => a.run_id === latest.run_id) : [];
  const checks = latest ? d.checks.filter((c) => c.run_id === latest.run_id) : [];
  const pr = artifacts.find((a) => a.kind === "pr")?.label ?? null;
  return (
    <div className="flex flex-col gap-4">
      {latest && run ? (
        <section data-testid="result-panel" aria-label="Latest result" className="rounded-lg border border-border bg-card p-4">
          <p className="text-sub text-muted-foreground">Run {run.attempt} · {AGENT_LABEL[run.agent]} · <RelTime iso={latest.created_at} /></p>
          <p className="mt-1 text-dense break-words whitespace-pre-wrap">{latest.summary}</p>
          {!!latest.changes.length && <><h4 className="mt-3 text-dense font-semibold">What changed</h4><ul className="mt-1 list-disc pl-5 text-dense">{latest.changes.map((c) => <li key={c} className="break-words">{c}</li>)}</ul></>}
          {!!artifacts.length && <><h4 className="mt-3 text-dense font-semibold">Evidence</h4><div className="mt-1 grid gap-2 md:grid-cols-2">{artifacts.map((a) => <ArtifactTile key={a.id} a={a} />)}</div></>}
          <h4 className="mt-3 text-dense font-semibold">Checks</h4>
          {checks.length ? (
            <><p className="text-sub text-muted-foreground">{checkSummary(checks)}</p>
            <ul className="mt-1 flex flex-col gap-1">{checks.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2 text-dense"><CheckChip state={c.state} /><span className="break-words">{c.name}</span><span className="text-sub text-muted-foreground">{c.source === "owner" ? "Owner check" : "Agent-reported"}</span>{c.detail && <span className="w-full text-sub break-words text-muted-foreground">{c.detail}</span>}</li>)}</ul></>
          ) : <p className="text-sub text-muted-foreground">No checks were reported.</p>}
          {!!latest.limitations.length && <><h4 className="mt-3 text-dense font-semibold">Known limitations</h4><ul className="mt-1 list-disc pl-5 text-dense">{latest.limitations.map((c) => <li key={c} className="break-words">{c}</li>)}</ul></>}
        </section>
      ) : <p className="text-dense text-muted-foreground">No result submitted yet.</p>}
      {d.task.status === "review" && !activeRun && latest && <ReviewBar d={d} prNumber={pr} />}
      {d.task.accepted_at && d.task.status === "done" && <p className="rounded-md bg-success-tint p-3 text-dense text-success">Outcome accepted {abs(d.task.accepted_at)}</p>}
      <section aria-label="Run history">
        <h3 className="mb-2 text-section font-semibold">Run history</h3>
        {d.runs.length ? <div className="flex flex-col gap-2">{d.runs.map((r) => <RunHistoryItem key={r.id} d={d} run={r} />)}</div> : <p className="text-dense text-muted-foreground">No runs yet.</p>}
      </section>
    </div>
  );
}

// ---- body ----

function Header({ d, onClose, isPanel }: { d: TaskDetail; onClose: () => void; isPanel: boolean }) {
  const toast = useToast();
  const refresh = useRefresh();
  const { data: snap } = useSnapshot();
  const t = d.task;
  const [title, setTitle] = useState(t.title);
  const [syncedTitle, setSyncedTitle] = useState(t.title);
  if (syncedTitle !== t.title) { setSyncedTitle(t.title); setTitle(t.title); }
  const running = d.runs.some((r) => isExecuting(r.state));
  const active = d.runs.some((r) => isActive(r.state));
  const patch = async (p: Parameters<typeof updateTaskAction>[0] extends never ? never : Record<string, unknown>) => {
    const r = await call(() => updateTaskAction({ id: t.id, patch: p }));
    if (!r.ok) toast(r.message);
    void refresh();
  };
  const fieldCls = "h-11 w-full rounded-sm border border-input bg-card px-2 text-sub md:h-7";
  return (
    <header>
      <div className="flex flex-wrap items-center gap-2">
        <button aria-label={isPanel ? "Close" : "Back"} onClick={onClose} className="grid size-11 place-items-center rounded-md hover:bg-muted md:size-7">{isPanel ? <X size={16} aria-hidden /> : <ArrowLeft size={16} aria-hidden />}</button>
        <span className="text-dense font-semibold">{taskRef(t.number)}</span>
        <span className="rounded-sm bg-status-inbox-bg px-2 py-0.5 text-label text-status-inbox-fg">Source: {SOURCE_LABEL[t.source]}</span>
        {t.archived_at && <span className="rounded-sm bg-status-inbox-bg px-2 py-0.5 text-label">Archived</span>}
        {t.cancelled_at && <span className="rounded-sm bg-danger-tint px-2 py-0.5 text-label text-danger">Cancelled</span>}
        <div className="ml-auto flex items-center gap-1">
          {isPanel && <Button variant="ghost" size="sm" asChild className="hidden md:inline-flex"><Link href={`/tasks/${t.number}?page=1`}><ExternalLink size={14} aria-hidden />Open as page</Link></Button>}
          <Button variant="ghost" size="sm" className="h-11 md:h-7" onClick={async () => { try { await navigator.clipboard.writeText(`${location.origin}/tasks/${t.number}`); toast("Link copied."); } catch { toast("Couldn't copy the link."); } }}>Copy link</Button>
          <Menu.Root>
            <Menu.Trigger aria-label="More" className="grid size-11 place-items-center rounded-md hover:bg-muted md:size-7"><MoreHorizontal size={16} aria-hidden /></Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" className="z-[70] min-w-40 rounded-md border border-border bg-popover p-1 shadow-lg">
                <Menu.Item disabled={running} className="cursor-pointer rounded-sm px-2 py-2 text-dense outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent" onSelect={async () => { const r = await call(() => archiveTaskAction({ id: t.id, archived: !t.archived_at })); if (!r.ok) toast(r.message); void refresh(); }}>{t.archived_at ? "Restore from archive" : "Archive"}</Menu.Item>
                <Menu.Item disabled={running || !!t.cancelled_at} className="cursor-pointer rounded-sm px-2 py-2 text-dense outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent" onSelect={async () => { const r = await call(() => cancelTaskAction({ id: t.id })); if (!r.ok) toast(r.message); void refresh(); }}>Cancel task</Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </div>
      <label className="mt-2 block"><span className="sr-only">Title</span>
        <textarea rows={1} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== t.title) void patch({ title }); else setTitle(t.title); }}
          className="field-sizing-content w-full resize-none rounded-sm border border-transparent bg-transparent px-1 text-[18px] leading-snug font-semibold break-words hover:border-input md:text-title" /></label>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-6">
        <label className="flex flex-col gap-1"><span className={labelClass}>Status</span><StatusSelect task={t} /></label>
        <label className="flex flex-col gap-1"><span className={labelClass}>Project</span>
          <select disabled={active} title={active ? "Locked while a run is active." : undefined} value={t.project_id} onChange={(e) => void patch({ project_id: e.target.value })} className={fieldCls}>
            {(snap?.projects ?? [d.project]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        <label className="flex flex-col gap-1"><span className={labelClass}>Priority</span>
          <select value={t.priority} onChange={(e) => void patch({ priority: e.target.value })} className={fieldCls}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
        <label className="flex flex-col gap-1"><span className={labelClass}>Next owner</span>
          <select disabled={t.status !== "in_progress"} title={t.status !== "in_progress" ? "Set from status. It can only be changed while In Progress." : undefined} value={t.status === "in_progress" ? t.owner_override ?? "auto" : t.next_owner} onChange={(e) => void patch({ owner_override: e.target.value === "auto" ? null : e.target.value })} className={fieldCls}>
            {t.status === "in_progress" ? <><option value="auto">Automatic</option><option value="denny">Denny</option><option value="ai">AI</option></> : <option value={t.next_owner}>{t.next_owner === "denny" ? "Denny" : t.next_owner === "ai" ? "AI" : "None"}</option>}
          </select></label>
        <label className="flex flex-col gap-1"><span className={labelClass}>Agent</span>
          <select value={t.agent ?? ""} onChange={(e) => void patch({ agent: e.target.value || null })} className={fieldCls}>
            <option value="claude_code">Claude Code</option><option value="codex" disabled={t.agent !== "codex"}>Codex (not available yet)</option><option value="">None (manual)</option>
          </select></label>
        <label className="flex flex-col gap-1"><span className={labelClass}>Due</span>
          <input type="date" value={t.due_date ?? ""} onChange={(e) => void patch({ due_date: e.target.value || null })} className={fieldCls} /></label>
      </div>
    </header>
  );
}

function ActivityTab({ d }: { d: TaskDetail }) {
  const abs = useFormatAbs();
  if (!d.activity.length) return <p className="text-dense text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {d.activity.map((a) => <li key={a.id} className="text-dense break-words"><span className="font-medium">{a.actor}</span> {a.text} <span className="text-sub text-muted-foreground">· <RelTime iso={a.at} /> · {abs(a.at)}</span></li>)}
    </ol>
  );
}

export function TaskBody({ number, onClose, isPanel }: { number: number; onClose: () => void; isPanel: boolean }) {
  const { data: d, error, isLoading } = useTaskDetail(number);
  const params = useSearchParams();
  const [tab, setTab] = useState(params.get("tab") === "results" ? "results" : "conversation");
  const scrolled = useRef(false);

  useEffect(() => {
    if (!d || scrolled.current || !location.hash) return;
    scrolled.current = true;
    document.querySelector(location.hash)?.scrollIntoView();
  }, [d]);

  if (isLoading) return <div className="flex flex-col gap-3" aria-busy="true"><Skeleton className="h-6 w-32" /><Skeleton className="h-8 w-3/4" /><Skeleton className="h-10 w-full" /><PageSkeleton /></div>;
  if (error || !d) return <div className="p-2"><p role="alert" className="text-dense text-danger">{error?.message ?? "Could not load the task."}</p><Button variant="secondary" className="mt-2" onClick={onClose}>Back</Button></div>;
  const open = d.requests.filter((r) => r.state === "open");
  const tabCls = "min-h-11 px-3 text-dense data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:font-medium md:min-h-9";

  return (
    <div className="flex flex-col gap-4">
      <Header d={d} onClose={onClose} isPanel={isPanel} />
      <RunBanner d={d} openResults={() => setTab("results")} />
      {open.map((r, i) => <RequestCard key={r.id} r={r} index={i} total={open.length} />)}
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List aria-label="Task sections" className="mb-3 flex gap-1 overflow-x-auto border-b border-border">
          <Tabs.Trigger value="conversation" className={tabCls}>Conversation ({d.messages.length})</Tabs.Trigger>
          <Tabs.Trigger value="results" className={tabCls}>Results ({d.runs.length})</Tabs.Trigger>
          <Tabs.Trigger value="activity" className={tabCls}>Activity</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="conversation" className="flex flex-col gap-4">
          <BriefBlock d={d} />
          <Criteria d={d} />
          <MessageList d={d} />
          <Composer d={d} onAnswerMode={() => document.querySelector("[data-testid=request-card]")?.scrollIntoView()} />
        </Tabs.Content>
        <Tabs.Content value="results"><ResultsTab d={d} /></Tabs.Content>
        <Tabs.Content value="activity"><ActivityTab d={d} /></Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

/** Panel on desktop, full page on phones or with ?page=1 (PRD section 4). */
export function TaskRoute({ number, background }: { number: number; background: React.ReactNode }) {
  const router = useRouter();
  const params = useSearchParams();
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 768px)");
    const on = () => setDesktop(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  const close = () => {
    const returnTo = number;
    if (window.history.length > 1) router.back(); else router.push("/tasks");
    // The opener remounts after navigation, so focus is restored by looking it up.
    let tries = 0;
    const t = setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-task-link="${returnTo}"]`);
      if ((el && !location.pathname.startsWith("/tasks/")) || ++tries > 20) { el?.focus(); clearInterval(t); }
    }, 50);
  };
  if (desktop === null) return <PageSkeleton />;
  if (!desktop || params.get("page") === "1") return <TaskBody number={number} onClose={close} isPanel={false} />;
  return (
    <>
      {background}
      <Dialog.Root open onOpenChange={(o) => { if (!o) close(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/20" />
          <Dialog.Content aria-describedby={undefined} data-testid="task-panel" className="fixed inset-y-0 right-0 z-50 w-full max-w-[900px] overflow-y-auto border-l border-border bg-background p-6 shadow-xl lg:w-[75vw]">
            <Dialog.Title className="sr-only">{taskRef(number)}</Dialog.Title>
            <TaskBody number={number} onClose={close} isPanel />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
