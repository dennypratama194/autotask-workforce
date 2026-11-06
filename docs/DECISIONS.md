# Decisions

Choices the PRD does not cover. Newest last.

## M0

1. **PRD location.** `docs/PRD.md` did not exist. Copied from `~/Desktop/TASK_WORKSPACE_PRD.md` unchanged.
2. **Schema ships in M0.** The PRD puts the schema in M1, but `pnpm seed` needs tables. The full section 5 schema and RLS are in `supabase/migrations/0001_schema.sql`. M1 builds on it.
3. **Inter font.** The global standards ban Inter as a display font. PRD 11.1 specifies Inter, and the PRD wins here.
4. **Tailwind v4, tokens in CSS.** Tokens live as CSS custom properties in `src/app/globals.css` and map into the Tailwind theme (`@theme inline`) and shadcn variables. No `tailwind.config`. The type scale sizes are named `text-label|sub|dense|base|section|title` (`sub`, not `secondary`, to avoid clashing with the `secondary` color).
5. **Next.js 16 `proxy.ts`.** Next 16 renamed `middleware.ts` to `proxy.ts`. Auth gating lives in `src/proxy.ts`.
6. **Single-email auth.** The magic-link request is refused server-side for any address other than `ALLOWED_EMAIL`, with the same response either way so the address is not revealed. The callback and proxy also sign out any session whose email differs. `shouldCreateUser: true` so the first sign-in creates the account; the allowed-email check is what limits access.
7. **Seed creates the owner user.** `pnpm seed` creates the `ALLOWED_EMAIL` auth user (pre-confirmed) if it does not exist, because every row needs `owner_id`. Seed is re-runnable: it deletes the owner's projects, tasks and workers first. It is not shipped as live data.
8. **Seed data is invented.** The canvas is not readable from the repo, so the seed uses 3 projects and 7 tasks covering every status, an open request, a result with mixed checks, and one queued run with worker offline. Replace later if the canvas data matters.
9. **Pinned versions.** ESLint 9 (eslint-config-next peers do not support 10 yet) and TypeScript 5.9 (7.x is the native port and not yet safe with Next tooling).
10. **shadcn components added on demand.** `components.json`, `cn` and `Button` exist; further components are added in M1 when screens need them.
11. **pnpm.** Not installed on this machine; installed globally with `npm i -g pnpm@9`.
12. **Task numbers.** Come from `task_number_seq` starting at 1, so seeded tasks are TW-1 to TW-7.
