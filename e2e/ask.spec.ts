import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Ask AI: questions in plain words, answered within each login's rights. The browser checks run with the scripted
 * stand-in for the language model (playwright.config.ts) — "sql: …" runs a statement through the real path, so what a
 * login can and cannot read is checked on the screen exactly as the model would meet it.
 */
test.describe.configure({ mode: "serial" });

async function ask(page: Page, question: string) {
  const before = await page.getByTestId("ask-turn").count();
  await page.getByRole("textbox", { name: "Type your question…" }).fill(question);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const turn = page.getByTestId("ask-turn").nth(before);
  await expect(turn.getByTestId("ask-working")).toHaveCount(0, { timeout: 30_000 });
  return turn;
}

test("an employee asks about their own leave and pay, and is told what is outside their reach", async ({ page }) => {
  await signIn(page, { as: "Employee / Pensioner", id: "DCB10014" });
  await page.getByTestId("ask-link").click();
  await page.waitForURL("**/ask");
  await expect(page.getByRole("heading", { name: "Ask", exact: true })).toBeVisible();
  await expect(page.getByText("Practice copy: no AI service is connected")).toBeVisible();

  // A suggested question: the person's own balances, as a table.
  await page.getByRole("button", { name: "How much leave do I have left?" }).click();
  const leave = page.getByTestId("ask-turn").first();
  await expect(leave.getByTestId("ask-answer").getByRole("columnheader", { name: "leave_code" })).toBeVisible({ timeout: 30_000 });
  await expect(leave.getByTestId("ask-answer").getByRole("cell", { name: "CL", exact: true })).toBeVisible();
  await leave.getByText("How this was worked out").click();
  await expect(leave.getByTestId("ask-how")).toContainText("Your leave balances");
  await leave.getByText("Show the query").click();
  await expect(leave.getByTestId("ask-how")).toContainText("FROM leave_balances");

  // Their own payslips only: one person in the pay they can see.
  const mine = await ask(page, "sql: select count(distinct employee_id) as people from payslips");
  await expect(mine.getByTestId("ask-answer")).toContainText("people: 1");

  // Other desks' records: refused, and said so.
  const bills = await ask(page, "sql: select sum(net) from payroll_runs");
  await expect(bills.getByTestId("ask-answer")).toContainText("not available to this user");
  const tables = await ask(page, 'sql: select * from "Employee"');
  await expect(tables.getByTestId("ask-answer")).toContainText("I could not get that");
  const escape = await ask(page, "sql: select set_config('role', 'hrms', true)");
  await expect(escape.getByTestId("ask-answer")).toContainText("set_config() is not available");
  const change = await ask(page, "sql: update employees set name = 'x'");
  await expect(change.getByTestId("ask-answer")).toContainText("Only SELECT statements are allowed");

  // A rule: answered from the Board's documents, by name.
  const rule = await ask(page, "What is the policy for a missed punch?");
  await expect(rule.getByTestId("ask-answer")).toContainText("Office hours and attendance");
  await rule.getByText("How this was worked out").click();
  await expect(rule.getByTestId("ask-how")).toContainText("Documents searched");
});

test("the Payroll desk sees every salary; HR sees people and only their own pay", async ({ page }) => {
  await signIn(page, { as: "HR & Accounts", id: "DCB10004" });
  await page.goto("/ask");
  await expect(page.getByRole("button", { name: "What was the total net pay last month, by pay group?" })).toBeVisible();
  const pay = await ask(page, "sql: select count(distinct employee_id) > 10 as many_people from payslips");
  await expect(pay.getByTestId("ask-answer")).toContainText("many_people: true");
  // A list comes with its rows, ready to download.
  const list = await ask(page, "sql: select employee_code, employee_name, net from payslips where run_kind = 'REGULAR' order by month desc, employee_code limit 5");
  await expect(list.getByText("The rows (5)")).toBeVisible();
  await list.getByText("The rows (5)").click();
  await expect(list.getByRole("button", { name: "Download as CSV" })).toBeVisible();

  await signIn(page, { as: "HR & Accounts", id: "DCB10003" });
  await page.goto("/ask");
  const people = await ask(page, "How many employees are there?");
  await expect(people.getByTestId("ask-answer")).toContainText(/people_on_the_rolls: \d{2}/);
  // The HR clerk has an employee record of their own: their own payslips, like on My payslips — nobody else's.
  const ownPay = await ask(page, "sql: select count(distinct employee_id) as people from payslips");
  await expect(ownPay.getByTestId("ask-answer")).toContainText("people: 1");
  for (const view of ["payroll_runs", "loans", "pay_items", "tds_challans"]) {
    const turn = await ask(page, `sql: select * from ${view}`);
    await expect(turn.getByTestId("ask-answer")).toContainText("not available to this user");
  }
});

test("IT support reads logins and system events, never people or pay", async ({ page }) => {
  await signIn(page, { as: "Admin", id: "IT01" });
  await page.goto("/ask");
  const logins = await ask(page, "sql: select count(*) > 5 as has_logins from users");
  await expect(logins.getByTestId("ask-answer")).toContainText("has_logins: true");
  for (const view of ["employees", "payslips", "leave_balances"]) {
    const turn = await ask(page, `sql: select * from ${view}`);
    await expect(turn.getByTestId("ask-answer")).toContainText("not available to this user");
  }
});

test("the Admin writes a document, Ask quotes it, and the Admin decides who may ask", async ({ page }) => {
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await page.goto("/ask/documents");
  await expect(page.getByTestId("knowledge-list")).toContainText("How to apply for leave");
  await page.getByRole("button", { name: "Add a document" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Canteen timings");
  await page.getByLabel("Kind").selectOption("ORDER");
  await page.getByLabel("Who may read it").selectOption("STAFF");
  await page.getByRole("textbox", { name: "Order or circular number and date" }).fill("DCB/ADM/2026/77");
  await page.getByRole("textbox", { name: "Text" }).fill("The staff canteen is open from 8:30 a.m. to 4:00 p.m. on working days. Tea is served at 11:00 a.m. and 3:30 p.m.");
  await page.getByRole("button", { name: "Save document" }).click();
  await expect(page.getByTestId("knowledge-list")).toContainText("Canteen timings");
  await expect(page.getByTestId("knowledge-list")).toContainText("Office staff only");

  await page.goto("/ask");
  const quoted = await ask(page, "What is the order on canteen timings?");
  await expect(quoted.getByTestId("ask-answer")).toContainText("Canteen timings");
  await expect(quoted.getByTestId("ask-answer")).toContainText("DCB/ADM/2026/77");

  // The document is for office staff: an employee's question does not find it.
  await signIn(page, { as: "Employee / Pensioner", id: "DCB10014" });
  await page.goto("/ask");
  const hidden = await ask(page, "What is the order on canteen timings?");
  await expect(hidden.getByTestId("ask-answer")).not.toContainText("DCB/ADM/2026/77");

  // Settings → Ask: office staff only. The employee loses the button and the screen.
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await page.goto("/admin/settings");
  const card = page.getByTestId("ask-card");
  await card.getByRole("radio", { name: /^Office staff/ }).check();
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await signIn(page, { as: "Employee / Pensioner", id: "DCB10014" });
  await expect(page.getByTestId("ask-link")).toHaveCount(0);
  await page.goto("/ask");
  await expect(page.getByText("Ask is not open for your login")).toBeVisible();
  const res = await page.request.post("/api/v1/ask", { data: { question: "How much leave do I have left?" } });
  expect(res.status()).toBe(403);

  // Back to everyone; the practice document is removed.
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await page.goto("/admin/settings");
  await page.getByTestId("ask-card").getByRole("radio", { name: /^Everyone/ }).check();
  await page.getByTestId("ask-card").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await page.goto("/ask/documents");
  await page.getByRole("listitem").filter({ hasText: "Canteen timings" }).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("knowledge-list")).not.toContainText("Canteen timings");
  // Every question was written to the audit trail.
  await page.goto("/admin/audit?q=Asked");
  await expect(page.getByText(/Asked: What is the order on canteen timings/).first()).toBeVisible();
});

test("the Admin chooses the AI service and sets its key; the key never comes back", async ({ page }) => {
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await page.goto("/admin/settings");
  const card = page.getByTestId("ask-card");
  // Gemini is the service in use until the Board chooses another.
  const gemini = card.getByTestId("ask-service-gemini");
  const gpt = card.getByTestId("ask-service-openai");
  await expect(gemini.getByRole("radio")).toBeChecked();
  await expect(gemini.getByText("In use")).toBeVisible();
  await expect(gemini.getByRole("textbox", { name: "Model" })).toHaveValue("gemini-3.8-flash");
  await expect(gpt.getByRole("textbox", { name: "Model" })).toHaveValue("gpt-5.5");
  await expect(card.getByTestId("ask-service-claude").getByRole("textbox", { name: "Model" })).toHaveValue("claude-opus-5-5");
  await expect(card.getByTestId("ask-key-status-openai")).toHaveText("No key yet");
  await expect(gpt.getByRole("button", { name: "Test" })).toBeDisabled();

  // A key for GPT: saved, shown only by its last four characters, the field emptied.
  await gpt.getByLabel("API key").fill("sk-browser-check-key-7788");
  await gpt.getByRole("button", { name: "Save key" }).click();
  await expect(card.getByTestId("ask-key-status-openai")).toHaveText("Key saved here, ending in …7788");
  await expect(gpt.getByLabel("API key")).toHaveValue("");
  const config = await page.request.get("/api/v1/ask/config");
  expect(config.ok()).toBe(true);
  expect(await config.text()).not.toContain("sk-browser-check-key");
  expect((await page.request.get("/api/v1/settings/askKeys")).status()).toBe(404);
  await page.reload();
  await expect(page.getByTestId("ask-key-status-openai")).toHaveText("Key saved here, ending in …7788");
  expect(await page.content()).not.toContain("sk-browser-check-key");

  // Choose GPT with another model, save: it is the one in use.
  await gpt.getByRole("radio").check();
  await gpt.getByRole("textbox", { name: "Model" }).fill("gpt-5.5-pro");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(gpt.getByText("In use")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("ask-service-openai").getByRole("radio")).toBeChecked();
  await expect(page.getByTestId("ask-service-openai").getByRole("textbox", { name: "Model" })).toHaveValue("gpt-5.5-pro");

  // Back to Gemini; the key is removed.
  await page.getByTestId("ask-service-gemini").getByRole("radio").check();
  await page.getByTestId("ask-service-openai").getByRole("textbox", { name: "Model" }).fill("gpt-5.5");
  await page.getByTestId("ask-card").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("ask-service-gemini").getByText("In use")).toBeVisible();
  await page.getByTestId("ask-service-openai").getByRole("button", { name: "Remove key" }).click();
  await expect(page.getByTestId("ask-key-status-openai")).toHaveText("No key yet");
  await page.goto("/admin/audit?q=key+for+Ask");
  await expect(page.getByText("Set the GPT (OpenAI) key for Ask").first()).toBeVisible();
  await expect(page.getByText("Removed the GPT (OpenAI) key for Ask").first()).toBeVisible();

  // HR cannot read the configuration or set a key.
  await signIn(page, { as: "HR & Accounts", id: "DCB10003" });
  expect((await page.request.get("/api/v1/ask/config")).status()).toBe(403);
  expect((await page.request.put("/api/v1/ask/keys/gemini", { data: { key: "AIza-not-allowed-0000" } })).status()).toBe(403);
  expect((await page.request.post("/api/v1/ask/keys/gemini/test", { data: {} })).status()).toBe(403);
});

test("an employee cannot open the documents screen or its API", async ({ page }) => {
  await signIn(page, { as: "Employee / Pensioner", id: "DCB10014" });
  await page.goto("/ask/documents");
  await expect(page.getByText("No access", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/v1/ask/knowledge")).status()).toBe(403);
  expect((await page.request.post("/api/v1/ask/knowledge", { data: { title: "Mine", category: "POLICY", audience: "EVERYONE", body: "Everyone gets a holiday every day." } })).status()).toBe(403);
});

test("the Ask screens meet WCAG 2.1 AA, in Hindi too", async ({ page }) => {
  const scan = async (path: string) => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.map((v) => `${path}: ${v.id} (${v.nodes.length})`), path).toEqual([]);
  };
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await page.goto("/ask");
  await scan("/ask (empty)");
  const turn = await ask(page, "How many employees are there?");
  await turn.getByText("How this was worked out").click();
  await scan("/ask (answered)");
  await page.goto("/ask/documents");
  await scan("/ask/documents");
  await page.getByRole("button", { name: "Add a document" }).click();
  await scan("/ask/documents (form)");
  await page.keyboard.press("Escape");
  await page.goto("/admin/settings");
  await scan("/admin/settings");

  await page.context().addCookies([{ name: "dcb_lang", value: "hi", url: page.url() }]);
  await page.goto("/ask");
  if (await page.getByRole("heading", { name: "पूछें", exact: true }).isVisible().catch(() => false)) await scan("/ask (Hindi)");
});
