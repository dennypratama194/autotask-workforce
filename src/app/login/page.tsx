import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6">
        <h1 className="mb-1 text-title font-semibold">Task Workspace</h1>
        <p className="mb-6 text-dense text-muted-foreground">Sign in with your email.</p>
        <LoginForm initialError={error} />
      </div>
    </main>
  );
}
