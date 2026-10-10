// Tutorial screenshot capture for "How to create a Sale Invoice"
// Run: node scripts/tutorial-capture.mjs
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";

const OUT = "/tmp/tutorial-shots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

// Step 1: Signup
console.log("Signing up...");
await page.goto("http://localhost:3000/signup");
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/01-signup.png` });

// Fill signup form - adjust selectors after inspecting
const email = `tutorial${Date.now()}@demo.com`;
try {
  await page.fill('input[name="companyName"], input[placeholder*="Company" i]', "Demo Trading Co");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "Demo1234!");
  await page.screenshot({ path: `${OUT}/02-signup-filled.png` });
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/03-after-signup.png` });
  console.log("Signup submitted, email:", email);
} catch (e) {
  console.log("Signup form fill issue:", e.message);
  await page.screenshot({ path: `${OUT}/02-signup-error.png` });
}

await browser.close();
console.log("Done. Shots in", OUT);
