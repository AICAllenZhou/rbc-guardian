import { expect, test, type Page } from "@playwright/test";

const GW = "http://127.0.0.1:3101";
const SHOTS = process.env.CAPTURE_SCREENSHOTS === "1";

async function resetDemo(page: Page) {
  const res = await page.request.post(`${GW}/api/demo/reset`, { data: {} });
  expect(res.ok()).toBeTruthy();
}

/** Click the suggested reply that matches, standing in for speech in the mock runtime. */
async function say(page: Page, pattern: RegExp) {
  const hints = page.getByTestId("hints");
  await expect(hints).toBeVisible();
  await hints.getByRole("button", { name: pattern }).click();
}

/** The live-case column (desktop). The phone layout repeats the phrase under the call. */
const caseColumn = (page: Page) => page.getByRole("complementary", { name: "Live case" });

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: true });
}

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
});

test("landing explains the concept and leads to the demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("The bank proves itself first.");
  await expect(page.getByTestId("disclaimer")).toContainText("Not an official RBC product");
  await expect(page.getByTestId("architecture")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Maya" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Atlas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nora" })).toBeVisible();
  await shot(page, "01-landing-desktop");
  await page.getByTestId("launch-demo").click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByTestId("runtime-mode")).toHaveText("Mock voice runtime");
});

test("Sentinel flow: detection, simulated call, reverse auth, one card lock, risk 99, summary", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByTestId("case-empty")).toBeVisible();
  await page.getByTestId("trigger-detection").click();

  const incoming = page.getByTestId("incoming-call");
  await expect(incoming).toBeVisible();
  await expect(incoming).toContainText("Simulated browser call");
  await expect(page.getByTestId("risk-score")).toHaveText("92");
  await shot(page, "02-incoming-call");
  await page.getByTestId("answer-call").click();

  const panel = page.getByTestId("call-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("call-status")).toContainText("Connected");
  await expect(panel).toContainText("Atlas, Fraud Sentinel");

  // Atlas discloses and authenticates itself first.
  await expect(page.getByTestId("transcript")).toContainText("I will never ask for your password, PIN, or a one-time code");
  const phrase = caseColumn(page).getByTestId("reverse-auth-phrase");
  await expect(phrase).toHaveText(/^[A-Z]+ [A-Z]+$/);
  const phraseText = (await phrase.textContent())!.trim();
  await expect(page.getByTestId("transcript")).toContainText(`Mine reads: ${phraseText}`);
  await shot(page, "03-reverse-auth");

  await say(page, /it matches/i);
  await expect(caseColumn(page).getByTestId("reverse-auth-verified")).toBeVisible();
  await expect(page.getByTestId("transcript")).toContainText("2,840 Canadian dollars at the Apple Store in Miami");

  await say(page, /that wasn't me/i);
  await expect(page.getByTestId("risk-score")).toHaveText("99");

  await say(page, /lock it/i);
  await expect(page.getByTestId("action-lock")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("action-flag")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("action-review")).toHaveAttribute("data-done", "true");
  // The mock deliberately calls the lock tool twice; it must apply once.
  await expect(page.locator('[data-event-type="card_locked"]')).toHaveCount(1);
  await expect(page.locator('[data-event-type="tool_replayed"]')).toHaveCount(1);

  // Transcript: committed messages are not duplicated by partials.
  const agentTexts = await page.getByTestId("message").filter({ has: page.locator("text=Atlas") }).allTextContents();
  expect(new Set(agentTexts).size).toBe(agentTexts.length);
  await expect(page.getByTestId("draft")).toHaveCount(0);
  await shot(page, "04-protected");

  await page.getByTestId("end-call").click();
  await expect(page.getByTestId("call-status")).toContainText("Call ended");
  await expect(page.getByTestId("call-summary")).toContainText("GUARD-4821");
  await page.getByTestId("open-command-center").click();

  await expect(page.getByTestId("cc-case-id")).toHaveText("GUARD-4821");
  await expect(page.getByTestId("risk-history")).toContainText("92");
  await expect(page.getByTestId("risk-history")).toContainText("99");
  await expect(page.getByTestId("tool-calls")).toContainText("duplicate ignored");
  await expect(page.getByTestId("cc-transcript")).toContainText("Atlas");
  await expect(page.getByTestId("sessions")).toContainText("Ended");
  await shot(page, "05-command-center");

  const summary = await page.request.get(`${GW}/api/cases/GUARD-4821/summary`);
  const body = await summary.json();
  expect(body.case.cardLocked).toBe(true);
  expect(body.events.filter((e: { type: string }) => e.type === "card_locked")).toHaveLength(1);
});

test("TrustLine flow opens a new case and Recovery continues it with a different agent", async ({ page }) => {
  await page.goto("/demo");
  await page.getByTestId("call-trustline").click();
  const panel = page.getByTestId("call-panel");
  await expect(panel).toContainText("Maya, Guardian TrustLine");
  await expect(caseColumn(page).getByTestId("reverse-auth-phrase")).toBeVisible();
  const caseId = (await page.getByTestId("case-id").textContent())!.trim();
  expect(caseId).toMatch(/^GUARD-\d{4}$/);
  expect(caseId).not.toBe("GUARD-4821");

  await say(page, /asked me to read them a code/i);
  await expect(page.getByTestId("case-status")).toHaveText("Open");
  await say(page, /didn't share/i);
  await expect(page.getByTestId("case-status")).toHaveText("Human review requested");
  await page.getByTestId("end-call").click();
  await expect(page.getByTestId("call-status")).toContainText("Call ended");

  await page.getByTestId("call-recovery").click();
  await expect(panel).toContainText("Nora, Recovery Specialist");
  await expect(page.getByTestId("transcript")).toContainText(`case ${caseId}`);
  await page.getByTestId("end-call").click();
  await expect(page.getByTestId("call-status")).toContainText("Call ended");
});

test("diagnostics show readiness without secret values", async ({ page }) => {
  await page.goto("/settings");
  const r = page.getByTestId("readiness");
  await expect(r).toContainText("Alebex mode");
  await expect(r).toContainText("Mock");
  await expect(r).toContainText("Gateway connected");
  const html = await page.content();
  expect(html).not.toContain("e2e-signing-secret");
  expect(html).not.toMatch(/wt_[A-Za-z0-9_-]{20,}/);
});

test("the browser never receives the Alebex token or tool credentials", async ({ page }) => {
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => typeof f.payload === "string" && frames.push(f.payload));
  });
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (res.url().startsWith(GW) && !res.url().includes("/api/events")) bodies.push(await res.text().catch(() => ""));
  });
  await page.goto("/demo");
  await page.getByTestId("trigger-detection").click();
  await page.getByTestId("answer-call").click();
  await expect(caseColumn(page).getByTestId("reverse-auth-phrase")).toBeVisible();
  await page.getByTestId("end-call").click();
  const all = [...frames, ...bodies].join("\n");
  expect(all).not.toContain("mock-runtime-token");
  expect(all).not.toContain("e2e-signing-secret");
  expect(all).not.toMatch(/alebex\.token\./);
  expect(all).not.toContain("X-Guardian-Session");
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("demo is usable at phone width without horizontal scroll", async ({ page }) => {
    await page.goto("/");
    await shot(page, "06-landing-mobile");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.goto("/demo");
    await page.getByTestId("trigger-detection").click();
    await page.getByTestId("answer-call").click();
    // The phrase is shown right under the call on phones, not only in the case column far below.
    await expect(page.getByTestId("reverse-auth-mobile").getByTestId("reverse-auth-phrase")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(page, "07-demo-mobile");
    await page.getByTestId("end-call").click();
  });
});
