
import fs from "node:fs";
import { chromium } from "playwright";

const required = [
  "SOUND_CAMPAIGN_URL",
  "PUSHOVER_USER_KEY",
  "PUSHOVER_API_TOKEN",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required GitHub variable/secret: ${key}`);
  }
}

const feedUrl = process.env.SOUND_CAMPAIGN_URL;
const statePath = "state/seen.json";
const storagePath = "storage-state.json";

// Confirmed SoundCampaign API endpoint.
const endpointHost = "prod-nest.soundcam.co";
const endpointPath = "/curator/reviews/available";

if (!fs.existsSync(storagePath)) {
  throw new Error(
    "storage-state.json is missing; check the SOUND_CAMPAIGN_STORAGE_STATE GitHub secret."
  );
}

fs.mkdirSync("state", { recursive: true });

const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { initialized: false, itemCount: null };

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    storageState: storagePath,
  });

  // Remove conditional cache headers to avoid 304 responses.
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

  // Verify that a URL belongs to the expected API endpoint.
  function isAvailableReviewsEndpoint(rawUrl) {
    try {
      const url = new URL(rawUrl);

      return (
        url.hostname === endpointHost &&
        url.pathname.replace(/\/+$/, "") === endpointPath
      );
    } catch {
      return false;
    }
  }

  // Verify the exact API filters used by the Tracks Feed.
  function isExpectedAvailableReviews(response) {
    try {
      const url = new URL(response.url());

      return (
        isAvailableReviewsEndpoint(response.url()) &&
        url.searchParams.get("filter") === "without_past_matches" &&
        url.searchParams.getAll("sortBy[]").includes("startDate.ASC") &&
        url.searchParams.get("hideAiGenerated") === "false"
      );
    } catch {
      return false;
    }
  }

  // Store network diagnostics for timeout investigation.
  const observedTraffic = [];

  // Log API requests.
  context.on("request", (request) => {
    if (!isAvailableReviewsEndpoint(request.url())) return;

    const info = {
      type: "REQUEST",
      method: request.method(),
      url: request.url(),
    };

    observedTraffic.push(info);

    console.log(
      "[SoundCampaign API]",
      JSON.stringify(info)
    );
  });

  // Log API responses.
  context.on("response", (response) => {
    if (!isAvailableReviewsEndpoint(response.url())) return;

    const info = {
      type: "RESPONSE",
      status: response.status(),
      url: response.url(),
    };

    observedTraffic.push(info);

    console.log(
      "[SoundCampaign API]",
      JSON.stringify(info)
    );
  });

  // Detect network failures.
  context.on("requestfailed", (request) => {
    if (!isAvailableReviewsEndpoint(request.url())) return;

    const info = {
      type: "REQUEST FAILED",
      error: request.failure()?.errorText,
      url: request.url(),
    };

    observedTraffic.push(info);

    console.error(
      "[SoundCampaign API]",
      JSON.stringify(info)
    );
  });

  console.log("Opening SoundCampaign Tracks Feed...");

  // Start listening before navigation to avoid missing the API response.
  // Convert rejection into a result so navigation errors cannot cause
  // an unhandled promise rejection.
  const responsePromise = context.waitForEvent("response", {
    predicate: isExpectedAvailableReviews,
    timeout: 45000,
  }).then(
    (response) => ({ response }),
    (error) => ({ error })
  );

  await page.goto(feedUrl, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  const currentUrl = page.url();

  if (/login|sign-in|auth/i.test(currentUrl) && !/tracks|feed/i.test(currentUrl)) {
    throw new Error(
      "SoundCampaign session appears expired; refresh the saved browser session."
    );
  }

  console.log("Waiting for available-reviews response...");

  const result = await responsePromise;

  if (result.error) {
    console.error(
      "SoundCampaign API traffic observed:",
      JSON.stringify(observedTraffic, null, 2)
    );

    const requestObserved = observedTraffic.some(
      (entry) => entry.type === "REQUEST"
    );

    if (!requestObserved) {
      throw new Error(
        "No SoundCampaign available-reviews API request was observed. " +
        "The page may not have triggered the API call.",
        { cause: result.error }
      );
    }

    throw new Error(
      "SoundCampaign API request was observed, but no response matched " +
      "the expected endpoint and filters.",
      { cause: result.error }
    );
  }

  const response = result.response;

  // Log the exact API URL and its parameters.
  console.log(`Observed API URL: ${response.url()}`);

  const observedUrl = new URL(response.url());

  console.log(
    "Observed API parameters:",
    JSON.stringify({
      filter: observedUrl.searchParams.get("filter"),
      sortBy: observedUrl.searchParams.getAll("sortBy[]"),
      hideAiGenerated: observedUrl.searchParams.get("hideAiGenerated"),
      pageNumber: observedUrl.searchParams.get("pageNumber"),
      pageSize: observedUrl.searchParams.get("pageSize"),
    })
  );

  console.log(
    `SoundCampaign response received: HTTP ${response.status()}`
  );

  // Additional safety check.
  if (
    observedUrl.searchParams.get("filter") !== "without_past_matches" ||
    !observedUrl.searchParams.getAll("sortBy[]").includes("startDate.ASC") ||
    observedUrl.searchParams.get("hideAiGenerated") !== "false"
  ) {
    throw new Error(
      "SoundCampaign API parameters have changed unexpectedly."
    );
  }

  if (response.status() === 304) {
    throw new Error(
      "SoundCampaign returned HTTP 304 without a response body."
    );
  }

  if (!response.ok()) {
    throw new Error(
      `SoundCampaign available-reviews request failed (HTTP ${response.status()}).`
    );
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "The available-reviews response was not valid JSON."
    );
  }

  // Log relevant API fields.
  console.log(
    "SoundCampaign API diagnostic:",
    JSON.stringify({
      itemCount: payload?.meta?.itemCount,
      reviewsOnPage: payload?.data?.reviews?.length,
      isLimitReached: payload?.data?.isLimitReached,
    })
  );

  const rawCount = payload?.meta?.itemCount;
  const fallbackCount = payload?.data?.reviews;

  let currentCount;

  if (
    rawCount !== undefined &&
    rawCount !== null &&
    Number.isFinite(Number(rawCount))
  ) {
    currentCount = Number(rawCount);
  } else if (Array.isArray(fallbackCount)) {
    currentCount = fallbackCount.length;
  } else {
    throw new Error(
      "The available-reviews JSON did not contain meta.itemCount or data.reviews."
    );
  }

  console.log(`Available submissions detected: ${currentCount}`);

  // Update detection state.
  state.initialized = true;
  state.itemCount = currentCount;

  if (currentCount >= 1) {
    console.log(
      `ALERT: ${currentCount} submission(s) detected. Sending Pushover notification...`
    );

    const body = new URLSearchParams({
      token: process.env.PUSHOVER_API_TOKEN,
      user: process.env.PUSHOVER_USER_KEY,
      title: "Soumissions SoundCampaign disponibles",
      message: `Il y a actuellement ${currentCount} soumission(s) disponible(s) dans ton Tracks Feed SoundCampaign.`,
      priority: "0",
    });

    let pushoverResponse;

    try {
      pushoverResponse = await fetch(
        "https://api.pushover.net/1/messages.json",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(15000),
        }
      );
    } catch (error) {
      throw new Error(
        `Pushover request failed: ${error.message}`,
        { cause: error }
      );
    }

    let pushoverResult;

    try {
      pushoverResult = await pushoverResponse.json();
    } catch {
      throw new Error(
        `Pushover returned an unreadable response (HTTP ${pushoverResponse.status()}).`
      );
    }

    if (!pushoverResponse.ok || pushoverResult?.status !== 1) {
      console.error(
        "Pushover response:",
        JSON.stringify(pushoverResult)
      );

      throw new Error(
        `Pushover rejected the notification (HTTP ${pushoverResponse.status()}).`
      );
    }

    console.log(
      `SUCCESS: Pushover accepted the notification. ${currentCount} submission(s) available.`
    );
  } else {
    console.log(
      "No available submissions (itemCount = 0). No notification sent."
    );
  }

  // Save state only after successful detection and notification handling.
  fs.writeFileSync(
    statePath,
    JSON.stringify(state, null, 2) + "\n"
  );

  console.log("Detection state saved.");

  await context.close();
} finally {
  await browser.close();
}
