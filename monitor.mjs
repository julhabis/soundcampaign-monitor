import fs from "node:fs";
import { chromium } from "playwright";

const required = [
  "SOUND_CAMPAIGN_URL",
  "PUSHOVER_USER_KEY",
  "PUSHOVER_API_TOKEN",
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required GitHub variable/secret: ${key}`);
}

const feedUrl = process.env.SOUND_CAMPAIGN_URL;
const statePath = "state/seen.json";
const storagePath = "storage-state.json";
const endpointPath = "/curator/direct-matchings/available-reviews";

if (!fs.existsSync(storagePath)) {
  throw new Error("storage-state.json is missing; check the SOUND_CAMPAIGN_STORAGE_STATE GitHub secret.");
}

fs.mkdirSync("state", { recursive: true });
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { initialized: false, itemCount: null };

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ storageState: storagePath });

  // The SoundCampaign page itself makes this request. We only observe its response.
  // Remove conditional cache headers so the browser is less likely to receive a 304
  // response without a JSON body.
  await context.route(`**${endpointPath}**`, async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
    headers["cache-control"] = "no-cache, no-store";
    headers["pragma"] = "no-cache";
    await route.continue({ headers });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  const responsePromise = page.waitForResponse(
    (response) => {
      try {
        return new URL(response.url()).pathname === endpointPath;
      } catch {
        return false;
      }
    },
    { timeout: 45000 }
  );

  await page.goto(feedUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

  const currentUrl = page.url();
  if (/login|sign-in|auth/i.test(currentUrl) && !/tracks|feed/i.test(currentUrl)) {
    throw new Error("SoundCampaign session appears expired; refresh the saved browser session.");
  }

  const response = await responsePromise;
  if (response.status() === 304) {
    throw new Error("SoundCampaign returned HTTP 304 without a response body. Retry after refreshing the page/session.");
  }
  if (!response.ok()) {
    throw new Error(`SoundCampaign available-reviews request failed (HTTP ${response.status()}).`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The available-reviews response was not valid JSON.");
  }

  const rawCount = payload?.meta?.itemCount;
  const fallbackCount = payload?.data?.reviews;
  let currentCount;
  if (rawCount !== undefined && rawCount !== null && Number.isFinite(Number(rawCount))) {
    currentCount = Number(rawCount);
  } else if (Array.isArray(fallbackCount)) {
    currentCount = fallbackCount.length;
  } else {
    throw new Error("The available-reviews JSON did not contain meta.itemCount or data.reviews.");
  }

  const baselineOnly = process.env.BASELINE_ONLY === "true";
  const previousCount = Number(state.itemCount);

  if (!state.initialized || baselineOnly || !Number.isFinite(previousCount)) {
    state.initialized = true;
    state.itemCount = currentCount;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    console.log(`Baseline saved: ${currentCount} available submission(s). No notification sent.`);
  } else if (currentCount >= 1) {
    const body = new URLSearchParams({
      token: process.env.PUSHOVER_API_TOKEN,
      user: process.env.PUSHOVER_USER_KEY,
      title: "Soumissions SoundCampaign disponibles",
      message: `Il y a actuellement ${currentCount} soumission(s) disponible(s) dans ton Tracks Feed SoundCampaign.`,
      priority: "0",
    });

    const pushoverResponse = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    let pushoverResult;
    try {
      pushoverResult = await pushoverResponse.json();
    } catch {
      throw new Error(`Pushover returned an unreadable response (HTTP ${pushoverResponse.status}).`);
    }
    if (!pushoverResponse.ok || pushoverResult?.status !== 1) {
      throw new Error(`Pushover rejected the notification (HTTP ${pushoverResponse.status}).`);
    }

    console.log(`Notification accepted by Pushover. ${currentCount} submission(s) currently available.`);
    state.itemCount = currentCount;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } else {
    console.log("No available submissions (itemCount = 0). No notification sent.");
    state.itemCount = currentCount;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  }

  await context.close();
} finally {
  await browser.close();
}
