// Tutorial: How to create a Sale Invoice — full capture
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";

const OUT = "/tmp/tutorial-shots";
fs.mkdirSync(OUT, { recursive: true });
const EXE = "/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

function getOtp(email) {
  try {
    const log = execSync("cat /tmp/devserver.log", { encoding: "utf8" });
    const lines = log.split("\n").filter(l => l.includes("[otp:dev]") && l.includes(email));
    if (lines.length) {
      const m = lines[lines.length - 1].match(/: (\d{6})/);
      return m ? m[1] : null;
    }
  } catch {}
  return null;
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const email = `tutorial${Date.now()}@demo.com`;

// --- Signup ---
console.log("1. Signing up...");
await page.goto("http://localhost:3000/signup");
await page.waitForTimeout(2000);
await page.fill('input[placeholder*="Ahmed Wholesale"]', "Demo Trading Co");
await page.fill('input[placeholder*="Ahmed Khan"]', "Demo User");
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', "Demo1234!");
await page.check('input[type="checkbox"]');
await page.click('button:has-text("Send code")');
await page.waitForTimeout(3000);

let otp = null;
for (let i = 0; i < 10 && !otp; i++) { await page.waitForTimeout(2000); otp = getOtp(email); }
console.log("OTP:", otp);
await page.fill('input[inputmode="numeric"], input[placeholder*="code" i]', otp);
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/t01-otp-entered.png` });
await page.waitForTimeout(2000);
await page.click('button:has-text("Verify code")');
await page.waitForTimeout(8000);
await page.screenshot({ path: `${OUT}/t02-dashboard.png` });
console.log("URL after signup:", page.url());

// --- Go to dashboard ---
await page.goto("http://localhost:3000/dashboard");
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/t03-dashboard-full.png` });

// --- New Sale Invoice ---
console.log("2. Opening new sale invoice...");
await page.goto("http://localhost:3000/sales/new");
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/t04-new-invoice.png` });
console.log("Invoice URL:", page.url());

await browser.close();
console.log("Done");
