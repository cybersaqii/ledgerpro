// Full tutorial capture: signup -> dashboard -> new sale invoice
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";

const OUT = "/tmp/tutorial-shots";
fs.mkdirSync(OUT, { recursive: true });
const EXE = "/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

function getOtp(email) {
  // Read OTP from dev server log
  try {
    const log = execSync("cat /tmp/devserver.log", { encoding: "utf8" });
    const lines = log.split("\n").filter(l => l.includes("[otp:dev]") && l.includes(email));
    if (lines.length) {
      const m = lines[lines.length - 1].match(/(\d{6})/);
      return m ? m[1] : null;
    }
  } catch {}
  return null;
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const email = `tutorial${Date.now()}@demo.com`;
console.log("Email:", email);

// --- Signup ---
await page.goto("http://localhost:3000/signup");
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/01-signup.png` });

await page.fill('input[placeholder*="Ahmed Wholesale"]', "Demo Trading Co");
await page.fill('input[placeholder*="Shop no"]', "Shop 12, Main Market");
await page.fill('input[placeholder*="Lahore"]', "Lahore");
await page.fill('input[placeholder*="Ahmed Khan"]', "Demo User");
await page.fill('input[type="email"]', email);
await page.fill('input[placeholder*="03xx"]', "03001234567");
await page.fill('input[type="password"]', "Demo1234!");
// Check terms consent checkbox
await page.check('input[type="checkbox"]');
await page.screenshot({ path: `${OUT}/02-signup-filled.png` });

await page.click('button:has-text("Send code")');
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/03-otp-sent.png` });

// Get OTP and enter it
let otp = null;
for (let i = 0; i < 10 && !otp; i++) {
  await page.waitForTimeout(2000);
  otp = getOtp(email);
}
console.log("OTP:", otp);

if (otp) {
  // Find OTP inputs
  const otpInputs = await page.$$('input[inputmode="numeric"], input[maxlength="1"]');
  console.log("OTP inputs found:", otpInputs.length);
  await page.screenshot({ path: `${OUT}/04-otp-page.png` });
}

await browser.close();
console.log("Done");
