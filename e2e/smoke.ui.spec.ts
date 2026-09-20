import { test, expect } from "@playwright/test";

/**
 * UI smoke tests — require a Playwright Chromium binary
 * (`npx playwright install chromium`). This project is only
 * included in playwright.config.ts when the binary exists.
 */

test("landing page loads with brand and language toggle", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/LedgerPro/i);
  // language toggle is present in the landing nav
  const toggle = page.getByRole("button", { name: /EN|اردو/i });
  await expect(toggle.first()).toBeVisible();
});

test("switching to Urdu translates the landing", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /EN|اردو/i }).first();
  await toggle.click();
  // html lang flips and a known Urdu string appears
  await expect(page.locator("html")).toHaveAttribute("lang", "ur");
  await expect(page.locator("body")).toContainText("مکمل");
});

test("login page renders and rejects bad credentials", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();
  await page.getByLabel(/email/i).fill("nobody@example.com");
  await page.getByLabel(/password/i).fill("wrongpassword1");
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  // an error surfaces (invalid credentials), not a crash
  await expect(page.locator("body")).toContainText(/invalid|incorrect|wrong/i, { timeout: 15000 });
});

test("protected routes redirect to login when signed out", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
});
