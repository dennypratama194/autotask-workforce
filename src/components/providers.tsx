"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { createBrowserClient } from "@supabase/ssr";
import type { Snapshot, TaskDetail } from "@/lib/domain/types";
import type { ActionResult } from "@/app/actions";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Signed out");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not load data.");
  return res.json();
}

const FAST_POLL = process.env.NEXT_PUBLIC_E2E === "1" ? 1500 : 30_000;

export const useSnapshot = () =>
  useQuery({ queryKey: ["snapshot"], queryFn: () => getJson<Snapshot>("/api/snapshot"), refetchInterval: FAST_POLL });
export const useTaskDetail = (n: number) =>
  useQuery({ queryKey: ["task", n], queryFn: () => getJson<TaskDetail>(`/api/tasks/${n}`), refetchInterval: FAST_POLL });

export function useRefresh() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries(), [qc]);
}

// ---- toast ----

type ToastAction = { label: string; run: () => void };
type Toast = { id: number; text: string; action?: ToastAction };
const ToastCtx = createContext<(text: string, action?: ToastAction) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

// ---- blocked dialog state (PRD 6.4) ----

export type Blocked = { title: string; reasons: string[]; projectSlug?: string; taskNumber?: number };
const BlockedCtx = createContext<{ blocked: Blocked | null; setBlocked: (b: Blocked | null) => void }>({ blocked: null, setBlocked: () => {} });
export const useBlocked = () => useContext(BlockedCtx);

/** Calls a server action; a dropped connection becomes a normal failure instead of a throw. */
export async function call<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T> & { network?: boolean }> {
  try {
    return await fn();
  } catch {
    return { ok: false, message: "Couldn't reach the server.", network: true };
  }
}

function Realtime() {
  const qc = useQueryClient();
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E === "1") return;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    const sb = createBrowserClient(url, key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refetch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries(), 200);
    };
    let channel = sb.channel("workspace");
    for (const table of ["tasks", "messages", "input_requests", "runs", "notifications"]) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, refetch);
    }
    // SUBSCRIBED also fires after a reconnect; never trust a missed event.
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") refetch();
    });
    return () => {
      clearTimeout(timer);
      sb.removeChannel(channel);
    };
  }, [qc]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2000, retry: 1, refetchOnReconnect: true } } }));
  const [toast, setToast] = useState<Toast | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const seq = useRef(0);
  const show = useCallback((text: string, action?: ToastAction) => setToast({ id: ++seq.current, text, action }), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.action ? 9000 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const blockedValue = useMemo(() => ({ blocked, setBlocked }), [blocked]);

  return (
    <QueryClientProvider client={client}>
      <ToastCtx.Provider value={show}>
        <BlockedCtx.Provider value={blockedValue}>
          <Realtime />
          {children}
          <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-4 bottom-24 z-[60] flex justify-center md:bottom-6">
            {toast && (
              <div data-testid="toast" className="pointer-events-auto flex max-w-lg items-center gap-3 rounded-md bg-foreground px-4 py-3 text-dense text-white shadow-lg">
                <span>{toast.text}</span>
                {toast.action && (
                  <button className="shrink-0 font-semibold underline" onClick={() => { toast.action!.run(); setToast(null); }}>
                    {toast.action.label}
                  </button>
                )}
              </div>
            )}
          </div>
        </BlockedCtx.Provider>
      </ToastCtx.Provider>
    </QueryClientProvider>
  );
}
