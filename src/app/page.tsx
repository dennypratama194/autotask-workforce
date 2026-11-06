import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex min-h-dvh max-w-[1440px] flex-col gap-4 px-6 py-12 md:px-12 lg:px-20">
      <h1 className="text-title font-semibold">Overview</h1>
      <p className="text-base text-muted-foreground">
        Signed in as {user?.email}. Screens arrive in the next milestone.
      </p>
      <div>
        <SignOutButton />
      </div>
    </main>
  );
}
