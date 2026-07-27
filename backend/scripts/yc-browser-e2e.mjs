import { chromium } from "playwright";

const url = process.env.YC_DEMO_URL || "https://silvervisit-api.vercel.app/demo";
const results = [];

for (let run = 1; run <= 3; run += 1) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  const failedResponses = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.url().includes("silvervisit-api.vercel.app") && response.status() >= 400) {
      failedResponses.push(`${response.request().method()} ${response.url()} -> ${response.status()}`);
    }
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector("#start", { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector("#patient")?.textContent?.includes("Fictional demo patient"), null, { timeout: 30_000 });
  await page.click("#start");
  await page.waitForSelector(".complete .big", { timeout: 240_000 });

  const completion = (await page.locator(".complete .big").innerText()).trim();
  const status = (await page.locator("#status").innerText()).trim();
  const logCount = await page.locator("#log .log-item").count();
  const logText = await page.locator("#log").innerText();

  if (completion !== "Visit joined") throw new Error(`Run ${run}: expected Visit joined, got ${completion}`);
  if (!status.includes("Completed")) throw new Error(`Run ${run}: completion status missing: ${status}`);
  if (logCount !== 7) throw new Error(`Run ${run}: expected 7 AI steps, got ${logCount}\n${logText}`);
  if (consoleErrors.length) throw new Error(`Run ${run}: console errors: ${consoleErrors.join(" | ")}`);
  if (failedResponses.length) throw new Error(`Run ${run}: failed responses: ${failedResponses.join(" | ")}`);

  await page.screenshot({ path: `yc-demo-run-${run}.png`, fullPage: true });
  results.push({ run, completion, status, logCount, passed: true });
  await browser.close();
}

console.log(JSON.stringify({ ok: true, url, results }, null, 2));
