import { NextResponse } from "next/server";
import { bearer, hashToken, serviceDb, type Ctx } from "@/lib/server/db";
import { handleRpc } from "@/lib/server/mcp";
import { now, q } from "@/lib/server/engine";

async function auth(req: Request): Promise<Ctx | null> {
  const token = bearer(req);
  if (!token) return null;
  const db = serviceDb();
  const rows = await q<{ owner_id: string; key: string }[]>(db.from("integrations").select("*").eq("token_hash", hashToken(token)).limit(1));
  const row = rows[0];
  if (!row) return null;
  await q(db.from("integrations").update({ last_success_at: now(), state: "connected" }).eq("key", row.key));
  return { db, ownerId: row.owner_id, actor: row.key === "codex_mcp" ? "Codex" : "Claude Code" };
}

export async function POST(req: Request) {
  const c = await auth(req);
  if (!c) return NextResponse.json({ error: "Invalid or missing bearer token." }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(c, m)))).filter(Boolean);
    return out.length ? NextResponse.json(out) : new NextResponse(null, { status: 202 });
  }
  const out = await handleRpc(c, body as Parameters<typeof handleRpc>[1]);
  return out ? NextResponse.json(out) : new NextResponse(null, { status: 202 });
}

// Stateless server: no server-initiated stream and no sessions to end.
const notAllowed = () => new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
