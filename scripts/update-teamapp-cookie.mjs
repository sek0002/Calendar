#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const envPath = path.resolve(process.env.TEAMAPP_ENV_PATH || process.env.TEAMAPP_COOKIE_ENV_PATH || path.join(repoRoot, ".env"));
const eventsUrl = process.env.TEAMAPP_EVENTS_URL || "https://muuc.teamapp.com/events?_list=v1";
const loginUrl = process.env.TEAMAPP_LOGIN_URL || "https://www.teamapp.com/user_session/new?_detail=v1";
const dashboardUrl = process.env.TEAMAPP_DASHBOARD_URL || "https://muuc.teamapp.com/clubs/132307/dashboard?_detail=v1";
const cookieDomains = ["https://muuc.teamapp.com"];
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

function isMuucTeamAppCookie(cookie) {
  return /(^|\.)muuc\.teamapp\.com$/i.test(cookie.domain || "");
}

function isRootTeamAppCookie(cookie) {
  return /(^|\.)teamapp\.com$/i.test(cookie.domain || "");
}

function mergeCookieValues(primaryCookies, allCookies) {
  const values = new Map();
  for (const cookie of primaryCookies) {
    if (authCookieNames.includes(cookie.name)) values.set(cookie.name, cookie.value);
  }
  for (const name of ["ta_auth_token", "_teamapp_session"]) {
    if (values.has(name)) continue;
    const cookie = allCookies.find((candidate) => candidate.name === name && isRootTeamAppCookie(candidate));
    if (cookie) values.set(name, cookie.value);
  }
  return values;
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
    'input[name="login"]',
    'input[name="user_session[email]"]',
    'input[name="user_session[login]"]',
    'input[name="user[email]"]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
  ]);
  let passwordInput = await firstVisible(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="user_session[password]"]',
    'input[name="user[password]"]',
    'input[id*="password" i]',
    'input[autocomplete="current-password"]',
  ]);

  if (!emailInput && !passwordInput) return false;

  if (emailInput) {
    await emailInput.fill(email);
  }

  let submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'button:has-text("Sign in")',
    'input[value*="Log" i]',
    'input[value*="Next" i]',
    'input[value*="Continue" i]',
    'input[value*="Sign" i]',
  ]);

  if (emailInput && !passwordInput && submit) {
    await Promise.allSettled([
      page.waitForURL(/user_session\/new.*token|users\/current\/clubs|dashboard|clubs/, { timeout: 20000 }),
      submit.click(),
    ]);
    await page
      .waitForSelector(
        'input[type="password"], input[name="password"], input[name="user_session[password]"], input[name="user[password]"], input[id*="password" i], input[autocomplete="current-password"]',
        { timeout: 10000 },
      )
      .catch(() => {});
    passwordInput = await firstVisible(page, [
      'input[type="password"]',
      'input[name="password"]',
      'input[name="user_session[password]"]',
      'input[name="user[password]"]',
      'input[id*="password" i]',
      'input[autocomplete="current-password"]',
    ]);
    submit = await firstVisible(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Continue")',
      'button:has-text("Sign in")',
      'input[value*="Log" i]',
      'input[value*="Continue" i]',
      'input[value*="Sign" i]',
    ]);
  }

  if (!passwordInput) return Boolean(emailInput);

  await passwordInput.fill(password);

  if (submit) {
    await Promise.allSettled([
      page.waitForURL(/users\/current\/clubs|dashboard|clubs/, { timeout: 20000 }),
      submit.click(),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  } else {
    await passwordInput.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  }
  return true;
}

function safeCookieSummary(cookies) {
  return cookies
    .map((cookie) => `${cookie.name}@${cookie.domain}`)
    .sort()
    .join(", ");
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
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    if (!(await fillLoginForm(page, email, password))) {
      throw new Error("Could not complete TeamApp login form");
    }

    await page.waitForTimeout(1500);
    await page.goto(dashboardUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(async () => {
      await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    });
    await page.goto(eventsUrl, { waitUntil: "networkidle", timeout: 30000 }).catch(async () => {
      await page.goto(eventsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    });

    const cookies = await context.cookies(cookieDomains);
    const allCookies = await context.cookies();
    const cookieByName = mergeCookieValues(cookies, allCookies);
    const foundNames = authCookieNames.filter((name) => cookieByName.has(name));
    const foundDetails = allCookies
      .filter(
        (cookie) =>
          (["ta_auth_token", "_teamapp_session"].includes(cookie.name) && isRootTeamAppCookie(cookie)) ||
          (cookie.name === "__stripe_mid" && isMuucTeamAppCookie(cookie)),
      )
      .map((cookie) => `${cookie.name}@${cookie.domain}`)
      .join(", ");

    if (!cookieByName.has("ta_auth_token") && !cookieByName.has("_teamapp_session")) {
      throw new Error(
        `Login did not produce the expected TeamApp auth cookies. TeamApp cookie names seen: ${foundDetails || safeCookieSummary(allCookies) || "none"}`,
      );
    }

    const cookieHeader = foundNames.map((name) => `${name}=${cookieByName.get(name)}`).join("; ");
    const updated = upsertEnv(envText, "TEAMAPP_COOKIE", cookieHeader);
    fs.writeFileSync(envPath, updated, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    console.log(`Updated TEAMAPP_COOKIE in ${envPath}. Found: ${foundNames.join(", ") || "none"}.`);
    if (foundDetails) console.log(`Cookie sources: ${foundDetails}.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Could not refresh TeamApp cookie: ${error.message}`);
  process.exit(1);
});
