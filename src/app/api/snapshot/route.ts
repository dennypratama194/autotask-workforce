import { NextResponse } from "next/server";
import { userCtx, UserError } from "@/lib/server/db";
import { snapshot } from "@/lib/server/engine";

export async function GET() {
  try {
    return NextResponse.json(await snapshot(await userCtx()));
  } catch (e) {
    if (e instanceof UserError) return NextResponse.json({ error: e.message }, { status: 401 });
    console.error(e);
    return NextResponse.json({ error: "Could not load data." }, { status: 500 });
  }
}
