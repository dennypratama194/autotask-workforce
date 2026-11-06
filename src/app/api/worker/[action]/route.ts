import { NextResponse } from "next/server";
import { z } from "zod";
import { bearer, serviceDb, UserError } from "@/lib/server/db";
import { addArtifact, appendLog, authWorker, beat, claim, finish } from "@/lib/server/worker-api";
import { callTool } from "@/lib/server/mcp";

const toolCall = z.object({ tool: z.enum(["post_update", "ask_denny", "submit_result", "report_failure"]), args: z.unknown() });

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const token = bearer(req);
  const w = token ? await authWorker(serviceDb(), token) : null;
  if (!w) return NextResponse.json({ error: "Invalid worker token." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { action } = await params;
  try {
    switch (action) {
      case "claim": return NextResponse.json(await claim(w.ctx, w.id));
      case "heartbeat": return NextResponse.json(await beat(w.ctx, w.id, body));
      case "finish": return NextResponse.json(await finish(w.ctx, w.id, body));
      case "log": return NextResponse.json(await appendLog(w.ctx, w.id, body));
      case "artifact": return NextResponse.json(await addArtifact(w.ctx, w.id, body));
      case "tool": {
        const t = toolCall.parse(body);
        return NextResponse.json(await callTool(w.ctx, t.tool, t.args));
      }
      default: return NextResponse.json({ error: "Unknown action." }, { status: 404 });
    }
  } catch (e) {
    if (e instanceof UserError || e instanceof z.ZodError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "Worker request failed." }, { status: 500 });
  }
}
