// Render slides/slides.html to PDF: node scripts/render-slides.mjs
import { chromium } from "@playwright/test";
import path from "node:path";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("file://" + path.resolve("slides/slides.html"));
await page.pdf({ path: "slides/juniper-salon-prototype.pdf", width: "1280px", height: "720px", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await browser.close();
