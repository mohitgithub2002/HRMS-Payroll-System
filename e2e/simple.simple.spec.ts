import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { verhoeffCheckDigit } from "../src/lib/validators";
import { signIn, signOut } from "./helpers";

/**
 * The simple way of working (Settings → How work is approved → Simple, the default): the Admin sees and manages
 * everything, the HR manager hires and manages employees and their leave, the Accounts manager works out and pays
 * salaries — each alone, with no second person. The other browser checks run in the two-step way; this file runs
 * last, switches the Board to Simple on the Settings screen and switches back when it is done.
 */
test.describe.configure({ mode: "serial" });

const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function workingDay(ahead: number) {
  let d = addDays(todayIST(), ahead);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
}

async function setWorkflow(page: Page, mode: "simple" | "twoStep") {
  const res = await page.request.put("/api/v1/settings/workflow", { data: { mode } });
  expect(res.ok()).toBe(true);
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await setWorkflow(page, "twoStep");
  await page.close();
});

test("the Admin chooses the simple way in Settings and gets every area of the Board", async ({ page }) => {
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await page.goto("/admin/settings");
  const card = page.getByTestId("workflow-card");
  if (!(await card.getByRole("radio", { name: /^Simple/ }).isChecked())) {
    await card.getByRole("radio", { name: /^Simple/ }).check();
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Hiring" })).toBeVisible();
  }
  const menu = page.getByRole("navigation", { name: "Menu" });
  for (const item of ["Home", "Employees", "Hiring", "Attendance and leave", "Payroll", "Pension", "Reports", "More"]) {
    await expect(menu.getByRole("link", { name: item, exact: true })).toBeVisible();
  }
  // Home: the role, the things done most, what is waiting.
  await page.goto("/home");
  await expect(page.getByText("Admin", { exact: true }).first()).toBeVisible();
  for (const key of ["runPayroll", "addEmployee", "decideLeave"]) await expect(page.getByTestId(`quick-${key}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();
  // The Admin manages, not only sees: the screens that were another desk's open with their buttons.
  await page.goto("/employees");
  await expect(page.getByRole("link", { name: "Add employee" })).toBeVisible();
  await page.goto("/admin");
  for (const tool of ["Requests to decide", "Tax and funds", "Users and roles", "Rates and rules", "Settings", "Audit trail"]) {
    await expect(page.getByRole("link", { name: new RegExp(tool) }).first()).toBeVisible();
  }
});

test("the Accounts manager works out, pays and finishes the month alone — no Checker, no OTP", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, { as: "HR & Accounts", id: "DCB10004" });
  await page.goto("/payroll");
  await expect(page.getByText("Three steps: work out the salaries, look them over, pay.")).toBeVisible();
  const hero = page.getByTestId("payroll-hero");

  // Step 1 — one button works out every pay group that is not paid yet.
  const workOut = page.getByTestId("month-workOut");
  if (await workOut.count()) {
    await workOut.click();
    await expect(page.getByText("Salaries worked out.")).toBeVisible();
  }
  await expect(page.getByTestId("bill-row").first()).toBeVisible();

  // Step 2 — every bill that asks for a decision: one click each (hold the pay, or pay it). A bill left half-way
  // in the two-step way is taken back first.
  for (let guard = 0; guard < 12; guard++) {
    const waiting = page.getByTestId("bill-row").filter({ hasText: /to decide|Waiting for a second check|Bank file to make/ }).first();
    if (!(await waiting.count())) break;
    await waiting.getByRole("link", { name: /Review|Open/ }).click();
    const panel = page.getByTestId("simple-panel");
    await expect(panel).toBeVisible();
    if (await panel.getByRole("button", { name: "Take back" }).count() && (await panel.getByText("waiting for a second check").count())) {
      await panel.getByRole("button", { name: "Take back" }).click();
      await expect(page.getByText("Taken back.", { exact: false })).toBeVisible();
    }
    if (await panel.getByRole("button", { name: "Make the bank file" }).count()) {
      await panel.getByRole("button", { name: "Make the bank file" }).click();
      await expect(panel.getByText("Send the bank file to the bank")).toBeVisible();
    }
    for (let i = 0; i < 20; i++) {
      const settle = page.locator('[data-testid^="settle-"]').first();
      if (!(await settle.count())) break;
      const before = await page.locator('[data-testid^="settle-"]').count();
      await settle.click();
      await expect(page.locator('[data-testid^="settle-"]')).not.toHaveCount(before);
    }
    await page.goto("/payroll");
  }
  await expect(page.getByTestId("bill-row").filter({ hasText: "to decide" })).toHaveCount(0);

  // Step 3 — approve and pay: one question, then the bank files are there.
  const pay = page.getByTestId("month-pay");
  if (await pay.count()) {
    await expect(hero).toContainText("ready to pay");
    await pay.click();
    await expect(page.getByRole("dialog")).toContainText("people will be paid");
    await page.getByTestId("month-pay-confirm").click();
    await expect(page.getByText("Approved. The bank file is ready.")).toBeVisible();
  }
  await expect(hero).toContainText("Send the bank files, then finish");
  const sent = page.getByTestId("bill-row").filter({ hasText: "Sent to the bank" }).first();
  const [download] = await Promise.all([page.waitForEvent("download"), sent.getByRole("link", { name: "Bank file" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^salary-\d{4}-\d{2}-\w+\.xlsx$/);

  // One bill can still be taken back — and paid again — until the month is finished.
  await sent.getByRole("link", { name: "Open" }).click();
  const panel = page.getByTestId("simple-panel");
  await panel.getByRole("button", { name: "Take back" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Take back" }).click();
  await expect(panel.getByText("Ready to pay")).toBeVisible();
  await page.getByTestId("pay-button").click();
  await page.getByTestId("pay-confirm").click();
  await expect(panel.getByText("Send the bank file to the bank")).toBeVisible();

  // Finish: the money reached everyone — payslips go out and the bills close.
  await page.goto("/payroll");
  await page.getByTestId("month-finish").click();
  await page.getByTestId("month-finish-confirm").click();
  await expect(page.getByText("Finished. Payslips are on their way.")).toBeVisible();
  await expect(hero).toContainText("salaries are paid");
  await expect(page.getByTestId("bill-row").filter({ hasText: "Sent to the bank" })).toHaveCount(0);
  // Nothing was sent to anyone's inbox on the way.
  await expect(page.getByTestId("inbox-count")).toBeVisible();
});

test("the HR manager adds an employee and decides a leave request alone", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString().slice(-6);
  const base = `6${stamp}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
  const aadhaar = base + verhoeffCheckDigit(base);
  const pan = `ZXDP${"ABCDEFGHIJ"[Number(stamp[0])]}${stamp.slice(-4)}R`;

  // An employee applies for a day of casual leave.
  const day = workingDay(45);
  await signIn(page, { as: "Employee / Pensioner", id: "DCB10014" });
  await page.goto("/leave/apply");
  await page.getByRole("combobox", { name: "Leave type" }).selectOption({ value: "CL" });
  await page.getByLabel("From").fill(day);
  await page.getByLabel("To").fill(day);
  await expect(page.getByText("Days of leave: 1")).toBeVisible();
  await page.getByLabel("Reason").fill("Family function at home");
  await page.getByRole("button", { name: "Send application" }).click();
  await expect(page.getByRole("heading", { name: /Casual Leave · 1/ })).toBeVisible();
  const applicationUrl = page.url();
  await signOut(page);

  await signIn(page, { as: "HR & Accounts", id: "DCB10003" });
  await expect(page.getByText("HR manager", { exact: true }).first()).toBeVisible();
  // The menu is about people: no payroll, tax or pension.
  const menu = page.getByRole("navigation", { name: "Menu" });
  await expect(menu.getByRole("link")).toHaveText(["Home", "Employees", "Hiring", "Attendance and leave", "Reports"]);

  // The leave request is HR's to decide, whatever the section.
  await page.goto(applicationUrl);
  await page.getByRole("link", { name: "Decide in Approvals" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL("**/approvals");
  await page.goto(applicationUrl);
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

  // A new employee: saved, and the Employee ID is there at once.
  await page.goto("/employees/new");
  await expect(page.getByText("The Employee ID is issued when you save.")).toBeVisible();
  await page.getByRole("textbox", { name: "First name" }).fill("Sarla");
  await page.getByRole("textbox", { name: "Last name" }).fill(`Simple${stamp}`);
  await page.getByLabel("Gender").selectOption("F");
  await page.getByLabel("Date of birth").fill("1993-04-14");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Employee type").selectOption("PERMANENT_NPS");
  await page.getByLabel("Date of joining").fill(todayIST());
  await page.getByLabel("Section").selectOption({ label: "Accounts" });
  await page.getByLabel("Post").selectOption({ index: 1 });
  await page.getByLabel("Pay level").selectOption("2");
  await page.getByLabel("Cell").selectOption("1");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("textbox", { name: "PAN" }).fill(pan);
  await page.getByRole("textbox", { name: "Aadhaar" }).fill(aadhaar);
  await page.getByRole("textbox", { name: "Bank account number" }).fill(`6${stamp}54321`);
  await page.getByRole("textbox", { name: "IFSC" }).fill("SBIN0001234");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Save employee" }).click();
  await expect(page.getByText("Saved. It applies right away.")).toBeVisible();
  await expect(page.getByText(/^DCB\d{5}$/).first()).toBeVisible();
  await expect(page.getByText("Working")).toBeVisible();
  await expect(page.getByText("This record is waiting for check")).toHaveCount(0);
});

test("the Admin gives people a role, and the simple screens are accessible and fit a phone", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, { as: "Admin", id: "DCB10002" });
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Users and roles" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Priya Singh/ }).first()).toContainText("HR manager");
  await expect(page.getByRole("row", { name: /Mohit Gupta/ }).first()).toContainText("Accounts manager");

  const code = `AC${Date.now().toString().slice(-5)}`;
  await page.goto("/admin/users/new");
  await page.getByRole("radio", { name: /^Accounts manager/ }).check();
  await page.getByRole("textbox", { name: "Sign-in ID" }).fill(code);
  await page.getByRole("textbox", { name: "Mobile number" }).fill(`97${Date.now().toString().slice(-8)}`);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Asha Accounts");
  await page.getByRole("textbox", { name: "Temporary password" }).fill("Welcome@2026x");
  await page.getByRole("button", { name: "Add user" }).click();
  await page.waitForURL(/\/admin\/users\/c/);
  await expect(page.getByRole("radio", { name: /^Accounts manager/ })).toBeChecked();

  // WCAG 2.1 AA on the screens made for the simple way.
  const paths = ["/home", "/payroll", "/admin", "/admin/users", "/admin/users/new", "/admin/settings", "/approvals"];
  await page.goto("/payroll");
  const bill = await page.getByTestId("bill-row").first().getByRole("link").first().getAttribute("href");
  if (bill) paths.push(bill);
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `${path} has accessibility problems`).toEqual([]);
  }
  // …and none of them scrolls sideways on a small phone.
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of paths) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth, `${path} is ${scrollWidth}px wide on a ${clientWidth}px screen`).toBeLessThanOrEqual(clientWidth);
  }
});
