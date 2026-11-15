
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import sodium from "libsodium-wrappers";
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

// Keep the original snapshot so we only rewrite the GitHub secret when
// cookies, localStorage, or IndexedDB have actually changed.
let initialStorageState;

try {
  initialStorageState = JSON.parse(fs.readFileSync(storagePath, "utf8"));
} catch {
  throw new Error("storage-state.json is not valid JSON.");
}

fs.mkdirSync("state", { recursive: true });

const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { initialized: false, itemCount: null };

async function updateGitHubSessionSecret(storageStateBase64) {
  const token = process.env.SESSION_SYNC_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const apiBase = (process.env.GITHUB_API_URL || "https://api.github.com")
    .replace(/\/+$/, "");

  if (!token) {
    throw new Error("Missing SESSION_SYNC_TOKEN repository secret.");
  }

  if (!repository || !repository.includes("/")) {
    throw new Error("GITHUB_REPOSITORY is missing or invalid.");
  }

  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("GITHUB_REPOSITORY must have the format owner/repository.");
  }

  if (Buffer.byteLength(storageStateBase64, "utf8") > 48 * 1024) {
    throw new Error(
      "The refreshed browser state exceeds GitHub's 48 KB repository-secret limit."
    );
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "soundcampaign-monitor",
  };

  const publicKeyUrl =
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    "/actions/secrets/public-key";

  const publicKeyResponse = await fetch(publicKeyUrl, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15000),
  });

  const publicKeyText = await publicKeyResponse.text();
  let publicKeyData;

  try {
    publicKeyData = JSON.parse(publicKeyText);
  } catch {
    throw new Error(
      `GitHub public-key endpoint returned invalid JSON (HTTP ${publicKeyResponse.status}).`
    );
  }

  if (!publicKeyResponse.ok) {
    throw new Error(
      `Cannot read GitHub repository public key (HTTP ${publicKeyResponse.status}): ` +
      `${publicKeyData?.message || "unknown API error"}`
    );
  }

  if (!publicKeyData?.key || !publicKeyData?.key_id) {
    throw new Error("GitHub did not return the repository public key and key_id.");
  }

  await sodium.ready;

  const publicKeyBytes = sodium.from_base64(
    publicKeyData.key,
    sodium.base64_variants.ORIGINAL
  );

  const encryptedBytes = sodium.crypto_box_seal(
    sodium.from_string(storageStateBase64),
    publicKeyBytes
  );

  const encryptedValue = sodium.to_base64(
    encryptedBytes,
    sodium.base64_variants.ORIGINAL
  );

  const secretName = "SOUND_CAMPAIGN_STORAGE_STATE";
  const updateUrl =
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/secrets/${encodeURIComponent(secretName)}`;

  const updateResponse = await fetch(updateUrl, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      encrypted_value: encryptedValue,
      key_id: publicKeyData.key_id,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!updateResponse.ok) {
    const errorText = await updateResponse.text();
    let errorMessage = errorText;

    try {
      errorMessage = JSON.parse(errorText)?.message || errorText;
    } catch {
      // Keep the plain response text for diagnostics.
    }

    throw new Error(
      `GitHub could not update ${secretName} (HTTP ${updateResponse.status}): ` +
      `${String(errorMessage).slice(0, 300)}`
    );
  }
}

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    storageState: storagePath,
  });

  // Avoid conditional cache responses such as HTTP 304.
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

  // Check whether a URL belongs to the expected API endpoint.
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

  // Check the expected API filters.
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

  // Store network diagnostics.
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
    console.log("[SoundCampaign API]", JSON.stringify(info));
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
    console.log("[SoundCampaign API]", JSON.stringify(info));
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
    console.error("[SoundCampaign API]", JSON.stringify(info));
  });

  console.log("Opening SoundCampaign Tracks Feed...");

  // Start listening before navigation.
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

  // Give the application time to render.
  await page.waitForTimeout(2000);

  // Diagnose the actual page displayed by SoundCampaign.
  const pageDiagnostics = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const normalized = body.toLowerCase();

    const hasPasswordField = Boolean(
      document.querySelector(
        'input[type="password"], input[autocomplete="current-password"]'
      )
    );

    const hasEmailField = Boolean(
      document.querySelector(
        'input[type="email"], input[autocomplete="username"], ' +
        'input[autocomplete="email"], input[name*="email" i], ' +
        'input[name*="username" i]'
      )
    );

    const loginText =
      /log in|login|sign in|connexion|se connecter|session expired|session has expired/i.test(
        normalized
      );

    const loginButton = Array.from(
      document.querySelectorAll("button, a, [role='button']")
    ).some((element) =>
      /log in|login|sign in|connexion|se connecter/i.test(
        element.innerText || element.getAttribute("aria-label") || ""
      )
    );

    return {
      url: location.href,
      title: document.title,
      hasPasswordField,
      hasEmailField,
      loginText,
      loginButton,
      bodyPreview: body.slice(0, 400),
    };
  });

  console.log(
    "SoundCampaign page diagnostics:",
    JSON.stringify(pageDiagnostics, null, 2)
  );

  // Detect a login redirect or a login form.
  const loginUrl =
    /login|log-in|sign-in|signin|auth|session/i.test(page.url());

  const loginDetected =
    pageDiagnostics.hasPasswordField &&
    (
      pageDiagnostics.hasEmailField ||
      pageDiagnostics.loginText ||
      pageDiagnostics.loginButton
    );

  if (loginUrl || loginDetected) {
    throw new Error(
      "SoundCampaign login page detected. " +
      "The saved browser session may have expired. " +
      "Refresh storage-state.json."
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

  // Validate the expected API parameters.
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

  // Capture refreshed browser credentials only after the authenticated API
  // response and JSON payload have been validated.
  try {
    // Allow any response handlers or token-refresh logic to finish.
    await page.waitForTimeout(500);

    const refreshedStorageState = await context.storageState({
      indexedDB: true,
    });

    if (!isDeepStrictEqual(initialStorageState, refreshedStorageState)) {
      const refreshedStorageStateJson = JSON.stringify(
        refreshedStorageState
      );

      // The workflow base64-decodes this secret before restoring the file,
      // so preserve that exact secret format when writing the refreshed state.
      const refreshedStorageStateBase64 = Buffer.from(
        refreshedStorageStateJson,
        "utf8"
      ).toString("base64");

      await updateGitHubSessionSecret(refreshedStorageStateBase64);

      console.log(
        "SoundCampaign browser state changed and was securely synchronized to GitHub."
      );
    } else {
      console.log(
        "SoundCampaign browser state is unchanged; GitHub secret was not rewritten."
      );
    }
  } catch (error) {
    // A failed session sync must not suppress a valid Pushover alert or
    // turn a successful availability check into a false negative.
    console.log(
      `::warning::Automatic SoundCampaign session sync failed: ${error.message}`
    );
  }

  // Update state only after successful API detection.
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

  // Save state after successful detection and notification handling.
  fs.writeFileSync(
    statePath,
    JSON.stringify(state, null, 2) + "\n"
  );

  console.log("Detection state saved.");

  await context.close();
} finally {
  await browser.close();
}
