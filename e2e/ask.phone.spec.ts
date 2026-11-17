import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/** Ask AI on a phone: nothing pushes the page sideways — a wide answer scrolls inside its own box. */
test("the Ask screen fits a phone screen, with an answer and its rows open", async ({ page }) => {
  await signIn(page, { as: "Employee / Pensioner", id: "DCB10014" });
  const fits = async (what: string) => {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth, `${what} is ${scrollWidth}px wide on a ${clientWidth}px screen`).toBeLessThanOrEqual(clientWidth);
  };
  await page.getByTestId("ask-link-mobile").click();
  await page.waitForURL("**/ask");
  await fits("/ask");
  await page.getByRole("textbox", { name: "Type your question…" }).fill("sql: select month, pay_group, run_kind, run_status, gross, deductions, net, employer_share, days_in_month, days_on_roll from payslips order by month desc");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const turn = page.getByTestId("ask-turn").first();
  await expect(turn.getByTestId("ask-answer")).toBeVisible({ timeout: 30_000 });
  await expect(turn.getByTestId("ask-working")).toHaveCount(0);
  await fits("/ask with a wide answer");
  await turn.getByText(/^The rows/).click();
  await turn.getByText("How this was worked out").click();
  await turn.getByText("Show the query").click();
  await fits("/ask with the rows and the query open");
});
