// Screenshot a Workflow in the Temporal Web UI into evidence/:
//   node scripts/capture-evidence.mjs <workflowId>
import { chromium } from "@playwright/test";
const id = process.argv[2];
if (!id) throw new Error("usage: node scripts/capture-evidence.mjs <workflowId>");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
await page.goto(`http://localhost:8233/namespaces/default/workflows/${id}`, { waitUntil: "networkidle" });
await page.getByText(id).first().waitFor({ timeout: 20_000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: "evidence/temporal-web-ui.png", fullPage: true });
await page.getByText(/^Event History/).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: "evidence/temporal-event-history.png", fullPage: true });
console.log("saved evidence/temporal-web-ui.png and evidence/temporal-event-history.png");
await browser.close();
