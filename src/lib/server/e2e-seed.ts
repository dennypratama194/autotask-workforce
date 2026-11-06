import { createHash } from "node:crypto";
import type { FakeDb } from "./fake-db";

export const E2E_MCP_TOKEN = "e2e-report-token";

/** Fixture for the Playwright suite only. */
export function e2eSeed(db: FakeDb) {
  const o = { owner_id: "e2e-owner" };
  const stamp = new Date().toISOString();
  db.tables.projects = [
    {
      ...o, id: "p1", slug: "restomart", name: "Restomart", purpose: "Ordering site", context: "", repo: "denny/restomart",
      base_branch: "main", preview_url: null, reference_links: [], worker_id: null, default_agent: "claude_code",
      verification_commands: [], retry_limit: 1, time_limit_minutes: 30, pinned: true, archived: false, created_at: stamp, updated_at: stamp,
    },
  ];
  db.tables.settings = [{ ...o, id: "s1", timezone: "device", setup_completed_at: stamp, setup_step: 5, created_at: stamp, updated_at: stamp }];
  db.tables.integrations = [
    { ...o, id: "i1", key: "claude_code_mcp", state: "connected", last_success_at: null, created_at: stamp, updated_at: stamp,
      token_hash: createHash("sha256").update(E2E_MCP_TOKEN).digest("hex") },
  ];
}
