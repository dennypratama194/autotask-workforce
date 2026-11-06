"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { requestMagicLink, type LoginState } from "./actions";

const initial: LoginState = { status: "idle" };

export function LoginForm({ initialError }: { initialError?: string }) {
  const [state, action, pending] = useActionState(requestMagicLink, initial);
  const message =
    state.message ?? (initialError ? errorCopy[initialError] ?? errorCopy.link_failed : undefined);
  const isError = state.status === "error" || (state.status === "idle" && !!initialError);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-dense font-medium text-foreground">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="h-11 rounded-sm border border-input bg-card px-3 text-base text-foreground md:h-[34px]"
        />
      </div>
      <Button type="submit" disabled={pending} className="h-11 md:h-[34px]">
        {pending ? "Sending link" : "Send sign-in link"}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={isError ? "text-dense text-danger" : "text-dense text-muted-foreground"}
      >
        {message}
      </p>
    </form>
  );
}

const errorCopy: Record<string, string> = {
  not_allowed: "This account isn't allowed to use this app.",
  link_failed: "That sign-in link didn't work. Request a new one.",
};
