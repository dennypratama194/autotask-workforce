# Task Workspace

Private task tracker for work done with Claude Code. See `docs/PRD.md` and `docs/DECISIONS.md`.

```bash
pnpm install
cp .env.example .env.local   # fill in
pnpm seed                    # optional sample data
pnpm dev
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`.

Worker (Phase 2): register it in Settings › Workers, then run the command shown there.
Add `--once` through `pnpm --filter @task-workspace/worker once` to process a single run.
