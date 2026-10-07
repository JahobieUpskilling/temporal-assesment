import { expect, test, type Page } from "@playwright/test";

// Default window is long enough that nobody times out mid-test; the timeout
// test overrides it with a short one.
const WINDOW_SECONDS = 60;
const SHORT_WINDOW_SECONDS = 6;

test.beforeEach(async ({ page }) => {
  // Any console error or failed API call fails the test.
  // (Only for our app; the Temporal Web UI has its own noisy iframes.)
  const ours = (url: string) => url.startsWith("http://localhost:3000");
  page.on("console", (message) => {
    // The browser logs our deliberate 409 ("reply refused") as a resource error; ignore it.
    if (message.type() === "error" && ours(message.location().url ?? page.url()) && !message.text().includes("409")) {
      throw new Error(`Console error: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    const status = response.status();
    // 409 is the API's "reply refused" answer; everything else 4xx/5xx is a bug.
    if (ours(response.url()) && status >= 400 && status !== 409) {
      throw new Error(`API error ${status} on ${response.request().method()} ${response.url()}`);
    }
  });
  // Each test starts with every simulated client free to receive an offer.
  await page.request.post("/api/holds/reset");
  await page.goto("/");
  await expect(page.getByTestId("client-select")).not.toBeEmpty();
});

async function startOpening(page: Page, options: { windowSeconds?: number; stylist?: string } = {}) {
  await page.getByTestId("stylist").selectOption(options.stylist ?? "Lena");
  await page.getByTestId("replyWindowSeconds").fill(String(options.windowSeconds ?? WINDOW_SECONDS));
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/openings") && r.request().method() === "POST"),
    page.getByTestId("start-offering").click(),
  ]);
  const { openingId } = (await created.json()) as { openingId: string };
  const opening = page.locator(`[data-opening-id="${openingId}"]`);
  // Newest opening is listed first.
  await expect(page.getByTestId("opening").first()).toHaveAttribute("data-opening-id", openingId);
  await expect(opening.getByTestId("phase")).toHaveText("offering");
  return opening;
}

// For a 2pm-ish Lena opening of 45 min the seeded waitlist yields, in join order:
// Priya (c1), Elena? no (120 min), Sam (c4), Jordan? depends on the clock, Aisha (c6)...
// Tests therefore read the current holder from the page instead of hard-coding it.
async function currentHolder(opening: ReturnType<Page["getByTestId"]>) {
  const text = await opening.getByTestId("current-offer").innerText();
  return text.split(" has the offer")[0].trim();
}

async function selectClient(page: Page, name: string) {
  const value = await page.locator("#client-select option", { hasText: name }).getAttribute("value");
  await page.getByTestId("client-select").selectOption(value!);
}

async function replyAs(page: Page, name: string, accepted: boolean) {
  await selectClient(page, name);
  await page.getByTestId(accepted ? "reply-yes" : "reply-no").click();
  return page.getByTestId("reply-result");
}

test("the first YES fills the opening and others are told", async ({ page }) => {
  const opening = await startOpening(page);
  const first = await currentHolder(opening);

  // The holder's phone shows the offer text.
  await selectClient(page, first);
  await expect(page.getByTestId("inbox").getByTestId("sms").first()).toContainText("Reply YES");

  // First person declines; the offer moves to the next eligible client.
  await expect(await replyAs(page, first, false)).toContainText("next person");
  await expect(opening.getByTestId("offers")).toContainText("declined");
  await expect(opening.getByTestId("phase")).toHaveText("offering");
  const second = await currentHolder(opening);
  expect(second).not.toBe(first);

  // Second person accepts: filled, winner shown, first person told it's filled.
  await expect(await replyAs(page, second, true)).toContainText("You've got it");
  await expect(opening.getByTestId("phase")).toHaveText("filled");
  await expect(opening.getByTestId("accepted-by")).toContainText(second);
  await expect(opening.getByTestId("accepted-by")).toContainText("book it in Square");
  await opening.locator("summary").click();
  await expect(opening.getByTestId("messages")).toContainText("has been filled");

  // Duplicate submission from the winner is refused, not double-booked.
  await expect(await replyAs(page, second, true)).toContainText("already taken");
  await expect(opening.getByTestId("accepted-by")).toContainText(second);
});

test("no reply: the offer expires and moves to the next person", async ({ page }) => {
  const opening = await startOpening(page, { windowSeconds: SHORT_WINDOW_SECONDS });
  const first = await currentHolder(opening);
  const countdown = opening.getByTestId("countdown");
  await expect(countdown).toContainText(/\d+s/);

  await expect(opening.getByTestId("offers")).toContainText("timed out", { timeout: (SHORT_WINDOW_SECONDS + 5) * 1000 });
  const second = await currentHolder(opening);
  expect(second).not.toBe(first);

  // The stale client replying YES after their window is refused.
  await expect(await replyAs(page, first, true)).toContainText("window ended");
  await expect(opening.getByTestId("late-replies")).toContainText(first);
  // ...and the live offer is unaffected.
  expect(await currentHolder(opening)).toBe(second);
});

test("a client who hasn't been offered it yet can't jump the queue", async ({ page }) => {
  const opening = await startOpening(page);
  const first = await currentHolder(opening);
  const waiting = (await opening.getByTestId("still-waiting").innerText()).split("\n")[0].trim();
  expect(waiting).not.toBe(first);
  await expect(await replyAs(page, waiting, true)).toContainText("haven't offered you");
  expect(await currentHolder(opening)).toBe(first);
});

test("staff can skip the current person and cancel the opening", async ({ page }) => {
  const opening = await startOpening(page, { windowSeconds: 120 });
  const first = await currentHolder(opening);
  await opening.getByTestId("skip").click();
  await expect(opening.getByTestId("offers")).toContainText("skipped by staff");
  expect(await currentHolder(opening)).not.toBe(first);

  page.once("dialog", (dialog) => dialog.accept("Stylist called in sick."));
  await opening.getByTestId("cancel").click();
  await expect(opening.getByTestId("phase")).toHaveText("cancelled");
  await expect(opening.getByTestId("reason")).toContainText("Stylist called in sick.");
  await expect(opening.getByTestId("offers")).toContainText("withdrawn");
  await expect(opening.getByTestId("skip")).toBeDisabled();
  await expect(opening.getByTestId("cancel")).toBeDisabled();
});

test("reloading the page during an active offer shows the same process", async ({ page }) => {
  const opening = await startOpening(page, { windowSeconds: 120 });
  const id = await opening.getAttribute("data-opening-id");
  const holder = await currentHolder(opening);

  await page.reload();
  const again = page.locator(`[data-opening-id="${id}"]`);
  await expect(again.getByTestId("phase")).toHaveText("offering");
  expect(await currentHolder(again)).toBe(holder);
  await expect(again.getByTestId("countdown")).toContainText(/\d+s/);

  // Still fully interactive after reload.
  await expect(await replyAs(page, holder, true)).toContainText("You've got it");
  await expect(again.getByTestId("phase")).toHaveText("filled");
});

test("the Temporal Web UI lists the opening Workflow", async ({ page }) => {
  const opening = await startOpening(page, { windowSeconds: 120 });
  const id = await opening.getAttribute("data-opening-id");
  // The Web UI's own API sees the running Workflow...
  const info = await page.request.get(`http://localhost:8233/api/v1/namespaces/default/workflows/${id}`);
  expect(info.ok()).toBe(true);
  expect(JSON.stringify(await info.json())).toContain("openingWorkflow");
  // ...and the Workflow page renders it.
  await page.goto(`http://localhost:8233/namespaces/default/workflows/${id}`);
  await expect(page.getByText(id!).first()).toBeVisible({ timeout: 15_000 });
});
