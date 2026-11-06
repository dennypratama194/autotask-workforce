import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/allowed-email";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && isAllowedEmail(data.user?.email)) {
      return NextResponse.redirect(`${origin}/`);
    }
    await supabase.auth.signOut();
    const reason = error ? "link_failed" : "not_allowed";
    return NextResponse.redirect(`${origin}/login?error=${reason}`);
  }

  return NextResponse.redirect(`${origin}/login?error=link_failed`);
}
