"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/allowed-email";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

const schema = z.object({ email: z.string().email() });

export async function requestMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  // Same response for disallowed addresses, so the allowed email is not revealed.
  if (!isAllowedEmail(parsed.data.email)) {
    return { status: "sent", message: "If this address is allowed, a sign-in link is on its way." };
  }

  const origin =
    process.env.NEXT_PUBLIC_APP_URL ?? (await headers()).get("origin") ?? "http://localhost:3000";
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${origin}/auth/callback`, shouldCreateUser: true },
  });
  if (error) return { status: "error", message: "Could not send the link. Try again in a minute." };
  return { status: "sent", message: "If this address is allowed, a sign-in link is on its way." };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
