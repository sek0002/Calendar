#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const envPath = path.join(repoRoot, ".env");
const eventsUrl = process.env.TEAMAPP_EVENTS_URL || "https://muuc.teamapp.com/events?_list=v1";
const loginUrl = process.env.TEAMAPP_LOGIN_URL || "https://www.teamapp.com/user_session/new?_detail=v1";
const authCookieNames = ["ta_auth_token", "_teamapp_session", "__stripe_mid"];

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
    'input[type="text"]',
    'input[name="email"]',
    'input[name="login"]',
    'input[name="user[email]"]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
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

async function submitControlNear(page, locator) {
  const form = locator.locator("xpath=ancestor::form[1]");
  if ((await form.count()) > 0) {
    const submit = form.locator('button[type="submit"], input[type="submit"], button').first();
    if ((await submit.count()) > 0) {
      await Promise.allSettled([
        page.waitForLoadState("networkidle", { timeout: 15000 }),
        submit.click(),
      ]);
      return;
    }
  }
  await locator.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

async function fillEmailStep(page, email) {
  const emailInput = await firstVisible(page, [
    'input[type="email"]',
    'input[type="text"]',
    'input[name="email"]',
    'input[name="login"]',
    'input[name="user_session[email]"]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
  ]);
  if (!emailInput) return false;
  await emailInput.fill(email);
  await submitControlNear(page, emailInput);
  return true;
}

async function fillPasswordStep(page, password) {
  const passwordInput = await firstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="user_session[password]"]',
    'input[name="user[password]"]',
    'input[id*="password" i]',
    'input[autocomplete="current-password"]',
  ]);
  if (!passwordInput) return false;
  await passwordInput.fill(password);
  await submitControlNear(page, passwordInput);
  return true;
}

async function loginWithTeamAppTwoStep(page, email, password) {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  if (!(await fillEmailStep(page, email))) return false;

  await page.waitForURL(/user_session\/new.*user_session%5Btoken%5D|user_session\/new.*user_session\[token\]|user_session\/new/, {
    timeout: 15000,
  }).catch(() => {});
  await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return fillPasswordStep(page, password);
}

function safeCookieSummary(cookies) {
  return cookies
    .map((cookie) => `${cookie.name}@${cookie.domain}`)
    .sort()
    .join(", ");
}

function uniqueCookies(cookies) {
  const byNameAndDomain = new Map();
  for (const cookie of cookies) {
    byNameAndDomain.set(`${cookie.name}@${cookie.domain}`, cookie);
  }
  return [...byNameAndDomain.values()];
}

async function readMuucCookies(context, page) {
  const scopedCookies = await context.cookies("https://muuc.teamapp.com");
  const documentCookie = await page.evaluate(() => document.cookie).catch(() => "");
  const documentCookies = documentCookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...rest] = part.split("=");
      return { name, value: rest.join("="), domain: "muuc.teamapp.com" };
    });
  const cdpSession = await context.newCDPSession(page).catch(() => null);
  const cdpCookies = cdpSession
    ? (await cdpSession.send("Network.getCookies", { urls: ["https://muuc.teamapp.com"] }).catch(() => ({ cookies: [] }))).cookies
    : [];
  return uniqueCookies([...scopedCookies, ...documentCookies, ...cdpCookies]);
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
    if (!(await fillLoginForm(page, email, password)) && !(await loginWithTeamAppTwoStep(page, email, password))) {
      throw new Error("Could not complete TeamApp login form");
    }

    {
      await page.goto(eventsUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(async () => {
        await page.goto(eventsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      });
    }

    const cookies = await readMuucCookies(context, page);
    const wanted = cookies.filter((cookie) => authCookieNames.includes(cookie.name));

    if (!wanted.some((cookie) => cookie.name === "ta_auth_token") && !wanted.some((cookie) => cookie.name === "_teamapp_session")) {
      throw new Error(`Login did not produce the expected TeamApp auth cookies. Cookie names seen: ${safeCookieSummary(cookies) || "none"}`);
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
