import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto("http://localhost:3000/signup");
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/signup-page.png" });
const inputs = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("input")).map(e => ({
    type: e.type, name: e.name, placeholder: e.placeholder
  }));
});
console.log(JSON.stringify(inputs, null, 1));
const buttons = await page.evaluate(() => {
  return Array.from(document.querySelectorAll("button")).map(e => e.textContent.trim().slice(0, 30));
});
console.log("Buttons:", JSON.stringify(buttons));
await browser.close();
