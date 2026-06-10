#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const envPath = path.join(repoRoot, ".env");
const eventsUrl = process.env.TEAMAPP_EVENTS_URL || "https://muuc.teamapp.com/events?_list=v1";

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    let value = rest.join("=").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key.trim()] = value;
  }
  return values;
}

function quoteEnv(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function upsertEnv(text, key, value) {
  const line = `${key}=${quoteEnv(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.trimEnd()}\n${line}\n`;
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) && (await locator.isVisible().catch(() => false))) return locator;
  }
  return null;
}

async function fillLoginForm(page, email, password) {
  const emailInput = await firstVisible(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="user[email]"]',
    'input[id*="email" i]',
    'input[autocomplete="email"]',
  ]);
  const passwordInput = await firstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="user[password]"]',
    'input[id*="password" i]',
    'input[autocomplete="current-password"]',
  ]);

  if (!emailInput || !passwordInput) return false;

  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'input[value*="Log" i]',
    'input[value*="Sign" i]',
  ]);

  if (submit) {
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 15000 }),
      submit.click(),
    ]);
  } else {
    await passwordInput.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  }
  return true;
}

async function main() {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing .env at ${envPath}`);
  }

  const envText = fs.readFileSync(envPath, "utf8");
  const env = { ...process.env, ...parseEnv(envText) };
  const email = env.TEAMAPP_EMAIL;
  const password = env.TEAMAPP_PASSWORD;

  if (!email || !password) {
    throw new Error("TEAMAPP_EMAIL and TEAMAPP_PASSWORD must be set in .env");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(eventsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    if (await fillLoginForm(page, email, password)) {
      await page.goto(eventsUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(async () => {
        await page.goto(eventsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      });
    }

    const cookies = await context.cookies(["https://muuc.teamapp.com", "https://www.teamapp.com"]);
    const wanted = cookies.filter((cookie) =>
      ["ta_auth_token", "_teamapp_session", "__stripe_mid"].includes(cookie.name),
    );

    if (!wanted.some((cookie) => cookie.name === "ta_auth_token") && !wanted.some((cookie) => cookie.name === "_teamapp_session")) {
      throw new Error("Login did not produce the expected TeamApp auth cookies");
    }

    const cookieHeader = wanted.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const updated = upsertEnv(envText, "TEAMAPP_COOKIE", cookieHeader);
    fs.writeFileSync(envPath, updated, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    console.log(`Updated TEAMAPP_COOKIE in ${envPath} (${wanted.length} cookies).`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Could not refresh TeamApp cookie: ${error.message}`);
  process.exit(1);
});
