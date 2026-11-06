import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** PRD section 13: the eight core flows, plus the 390 px overflow check. */

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TOKEN = "e2e-report-token";

async function mcp(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${TOKEN}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, ...(name === "get_answer" || name === "get_task" ? {} : { event_id: crypto.randomUUID() }) } } },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.result.isError, JSON.stringify(body)).toBeFalsy();
  return JSON.parse(body.result.content[0].text);
}

async function linkedTask(request: APIRequestContext, title: string) {
  const { task_id } = await mcp(request, "create_task", { project_slug: "restomart", title, brief: "A brief long enough to act on", criteria: ["It works"] });
  const session_id = `s-${stamp()}`;
  await mcp(request, "link_session", { task_id, session_id });
  return { task_id: task_id as string, session_id, number: Number(task_id.replace("TW-", "")) };
}

async function submit(request: APIRequestContext, task_id: string, session_id: string) {
  await mcp(request, "submit_result", {
    task_id, session_id, summary: "Finished the work", changes: ["Changed a thing"], limitations: ["One limit"],
    checks: [{ name: "Build", state: "Passed" }, { name: "Lint", state: "Failed" }, { name: "A11y", state: "Not run" }],
    artifacts: [{ kind: "pr", label: "PR #7", url: "https://example.com/pr/7" }],
  });
}

async function createInbox(page: Page, title: string) {
  await page.goto("/tasks?view=kanban");
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Title (required)").fill(title);
  await page.getByLabel("Outcome and brief").fill("Describe the outcome in a sentence or two here.");
  await page.getByRole("button", { name: "Save to Inbox" }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+/);
  return Number(/\/tasks\/(\d+)/.exec(page.url())![1]);
}

test("1. create a task and save to Inbox", async ({ page }) => {
  const title = `Inbox task ${stamp()}`;
  const n = await createInbox(page, title);
  await page.goto("/tasks?view=kanban");
  await expect(page.getByTestId("col-inbox").getByTestId(`card-${n}`)).toContainText(title);
});

test("2. a comment does not create a run", async ({ page }) => {
  const n = await createInbox(page, `Comment task ${stamp()}`);
  await page.goto(`/tasks/${n}?page=1`);
  await page.getByLabel("Message", { exact: true }).fill("Just a note");
  await page.getByRole("button", { name: "Comment", exact: true }).last().click();
  await expect(page.getByTestId("message").first()).toContainText("Just a note");
  await page.getByRole("tab", { name: /Results/ }).click();
  await expect(page.getByRole("tab", { name: "Results (0)" })).toBeVisible();
  await expect(page.getByText("No runs yet.")).toBeVisible();
});

test("3. MCP ask_denny appears on Overview and Needs Denny", async ({ page, request }) => {
  const { task_id, session_id, number } = await linkedTask(request, `Asked ${stamp()}`);
  await mcp(request, "ask_denny", { task_id, session_id, question: "Which provider?", kind: "choice", choices: ["Midtrans", "Xendit"], blocks: "Checkout" });
  await page.goto("/");
  await expect(page.getByTestId(`attention-${number}`)).toContainText("Which provider?");
  await page.goto("/needs");
  await expect(page.getByTestId(`needs-${number}`)).toContainText("Blocks: Checkout");
});

test("4. answering on a 390 px viewport resolves the request", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { task_id, session_id, number } = await linkedTask(request, `Mobile ${stamp()}`);
  const { request_id } = await mcp(request, "ask_denny", { task_id, session_id, question: "Pick one", kind: "choice", choices: ["Left", "Right"] });
  await page.goto(`/tasks/${number}`);
  const answer = page.getByRole("button", { name: "Answer and Resume" }).first();
  await answer.click();
  await expect(page.getByText("Choose an option.")).toBeVisible();
  await page.getByRole("radio", { name: "Right" }).check();
  await answer.click();
  await expect(page.getByTestId("request-card")).toHaveCount(0);
  const a = await mcp(request, "get_answer", { request_id });
  expect(a).toMatchObject({ state: "resolved", answer_choice: 1, answer_choice_text: "Right" });
});

test("5. submit_result moves the task to Review", async ({ page, request }) => {
  const { task_id, session_id, number } = await linkedTask(request, `Result ${stamp()}`);
  await submit(request, task_id, session_id);
  await page.goto("/tasks?view=kanban");
  await expect(page.getByTestId("col-review").getByTestId(`card-${number}`)).toContainText("Checks: 1 failed, 1 passed, 1 not run");
});

test("6. request changes, then approve", async ({ page, request }) => {
  const { task_id, session_id, number } = await linkedTask(request, `Review ${stamp()}`);
  await submit(request, task_id, session_id);
  await page.goto(`/tasks/${number}?page=1&tab=results`);
  await expect(page.getByTestId("review-bar")).toContainText("doesn't merge PR #7");
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  await page.getByLabel("What should change?").fill("too short");
  await page.getByRole("button", { name: "Request changes and queue run" }).click();
  await expect(page.getByText("Describe what should change")).toBeVisible();
  await page.getByLabel("What should change?").fill("Make the header 8 px smaller");
  await page.getByRole("button", { name: "Request changes and queue run" }).click();
  await expect(page.getByTestId("review-bar")).toHaveCount(0);

  const got = await mcp(request, "get_task", { task_id });
  expect(got.pending_instructions).toEqual(["Make the header 8 px smaller"]);
  const s2 = `s-${stamp()}`;
  await mcp(request, "link_session", { task_id, session_id: s2 });
  await submit(request, task_id, s2);
  await page.reload();
  await page.getByRole("button", { name: "Approve completion" }).click();
  await expect(page.getByText(/Outcome accepted/).last()).toBeVisible();
  await page.goto("/tasks?view=kanban");
  await expect(page.getByTestId("col-done").getByTestId(`card-${number}`)).toBeVisible();
});

test("7. an invalid drag shows the reason and restores the card", async ({ page }) => {
  const n = await createInbox(page, `Drag ${stamp()}`);
  await page.goto("/tasks?view=kanban");
  const card = page.getByTestId(`card-${n}`);
  await expect(page.getByTestId("col-inbox").getByTestId(`card-${n}`)).toBeVisible();
  const from = (await card.boundingBox())!;
  const to = (await page.getByTestId("col-review").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height - 8);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId("toast")).toContainText("Review needs a submitted result");
  await expect(page.getByTestId("col-inbox").getByTestId(`card-${n}`)).toBeVisible();
});

test("8. filter empty state", async ({ page }) => {
  await createInbox(page, `Filter ${stamp()}`);
  await page.goto("/tasks?view=list");
  await page.getByLabel("Filter tasks").fill("zzz-no-such-task");
  await expect(page.getByText("No tasks match these filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).last().click();
  await expect(page.getByLabel("Filter tasks")).toHaveValue("");
  await expect(page.getByText("No tasks match these filters")).toHaveCount(0);
});

test("the Move menu works by keyboard", async ({ page }) => {
  const n = await createInbox(page, `Keyboard ${stamp()}`);
  await page.goto("/tasks?view=kanban");
  await page.getByRole("button", { name: `Move TW-${n}` }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Needs Denny" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("col-needs_denny").getByTestId(`card-${n}`)).toBeVisible();
});

test("Esc closes the task panel and returns focus to the opener", async ({ page }) => {
  const n = await createInbox(page, `Panel ${stamp()}`);
  await page.goto("/tasks?view=kanban");
  const link = page.locator(`[data-task-link="${n}"]`).first();
  await link.click();
  await expect(page.getByTestId("task-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/tasks\?/);
  await expect(page.locator(`[data-task-link="${n}"]`).first()).toBeFocused();
});

test("rejects MCP calls without a valid token", async ({ request }) => {
  const res = await request.post("/api/mcp", { headers: { Authorization: "Bearer wrong" }, data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  expect(res.status()).toBe(401);
});

test.describe("390 px layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const path of ["/", "/tasks?view=list", "/tasks?view=kanban", "/needs", "/projects", "/projects/restomart?tab=settings", "/settings", "/settings?section=workers", "/setup"]) {
    test(`no horizontal overflow on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
  test("primary controls are at least 44 px and the tab bar shows", async ({ page, request }) => {
    const { task_id, session_id, number } = await linkedTask(request, `Tall ${stamp()}`);
    await mcp(request, "ask_denny", { task_id, session_id, question: "Size check", kind: "text" });
    await page.goto("/needs");
    await expect(page.getByTestId("attention-count-mobile")).toBeVisible();
    const box = await page.getByTestId(`needs-${number}`).getByRole("link", { name: "Answer" }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.goto(`/tasks/${number}`);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
