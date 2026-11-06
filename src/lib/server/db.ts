import { createHash, randomBytes } from "node:crypto";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/allowed-email";
import { FakeDb } from "./fake-db";
import { e2eSeed } from "./e2e-seed";

export type Db = SupabaseClient;
export type Ctx = { db: Db; ownerId: string; actor: string };

export class UserError extends Error {
  constructor(message: string, public blocked?: string[]) {
    super(message);
  }
}

export const isFakeDb = () => process.env.E2E_FAKE_DB === "1" && process.env.NODE_ENV !== "production";

const g = globalThis as unknown as { __fakeDb?: FakeDb };
function fake(): Db {
  if (!g.__fakeDb) {
    g.__fakeDb = new FakeDb();
    e2eSeed(g.__fakeDb);
  }
  return g.__fakeDb as unknown as Db;
}

export function serviceDb(): Db {
  if (isFakeDb()) return fake();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } });
}

/** Context for browser-initiated work: the signed-in owner, through RLS. */
export async function userCtx(): Promise<Ctx> {
  if (isFakeDb()) return { db: fake(), ownerId: "e2e-owner", actor: "Denny" };
  const db = await createSessionClient();
  const { data } = await db.auth.getUser();
  if (!data.user || !isAllowedEmail(data.user.email)) throw new UserError("Sign in to continue.");
  return { db, ownerId: data.user.id, actor: "Denny" };
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}
