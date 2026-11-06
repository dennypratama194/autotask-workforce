import { NextResponse } from "next/server";
import { isFakeDb, userCtx, UserError } from "@/lib/server/db";
import { taskDetail } from "@/lib/server/engine";

export async function GET(_: Request, { params }: { params: Promise<{ number: string }> }) {
  const n = Number((await params).number);
  if (!Number.isInteger(n)) return NextResponse.json({ error: "Not a task id." }, { status: 400 });
  try {
    const c = await userCtx();
    const d = await taskDetail(c, n);
    if (!isFakeDb()) {
      await Promise.all(d.attachments.map(async (a) => {
        const { data } = await c.db.storage.from("attachments").createSignedUrl(a.storage_path, 3600);
        a.url = data?.signedUrl ?? null;
      }));
    }
    return NextResponse.json(d);
  } catch (e) {
    if (e instanceof UserError) return NextResponse.json({ error: e.message }, { status: 404 });
    console.error(e);
    return NextResponse.json({ error: "Could not load the task." }, { status: 500 });
  }
}
