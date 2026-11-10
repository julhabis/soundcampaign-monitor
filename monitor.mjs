import fs from "node:fs";
import crypto from "node:crypto";
import { chromium } from "playwright";

const required = ["PUSHOVER_USER_KEY", "PUSHOVER_API_TOKEN"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}

const url = process.env.SOUND_CAMPAIGN_URL || "https://app.soundcamps.com/";
const statePath = "state/seen.json";
const storagePath = "storage-state.json";
const cardSelector = process.env.TRACK_CARD_SELECTOR;
const idSelector = process.env.TRACK_ID_SELECTOR;
const titleSelector = process.env.TRACK_TITLE_SELECTOR;
const artistSelector = process.env.TRACK_ARTIST_SELECTOR;
const linkSelector = process.env.TRACK_LINK_SELECTOR;
const readySelector = process.env.TRACK_READY_SELECTOR;

if (!cardSelector) {
  throw new Error("Set GitHub variable TRACK_CARD_SELECTOR to the CSS selector for one track card. See README.");
}
if (!fs.existsSync(storagePath)) throw new Error("storage-state.json is missing.");

const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { seen: [], initialized: false };

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  if (readySelector) await page.locator(readySelector).first().waitFor({ state: "visible", timeout: 15000 });
  else await page.waitForTimeout(2500);

  // If redirected to login or challenged, fail without dumping page contents or secrets.
  const current = page.url();
  if (/login|sign-in|auth/i.test(current) && !/tracks|feed/i.test(current)) {
    throw new Error("SoundCampaign session appears expired; refresh the saved browser session.");
  }

  const cards = await page.locator(cardSelector).evaluateAll((nodes, selectors) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    return nodes.map((node) => {
      const pick = (selector) => selector ? node.querySelector(selector) : null;
      const idNode = pick(selectors.id);
      const titleNode = pick(selectors.title);
      const artistNode = pick(selectors.artist);
      const linkNode = pick(selectors.link);
      const href = linkNode?.getAttribute("href") || "";
      const title = clean(titleNode?.textContent);
      const artist = clean(artistNode?.textContent);
      const rawId = idNode?.getAttribute("data-id")
        || idNode?.getAttribute("id")
        || idNode?.textContent?.trim()
        || href
        || `${artist}|${title}`;
      if (!title && !artist && !href && !rawId) return null;
      const id = clean(rawId) || `${artist}|${title}|${href}`;
      return { id, title, artist, href };
    }).filter(Boolean);
  }, { id: idSelector || null, title: titleSelector || null, artist: artistSelector || null, link: linkSelector || null });

  const normalized = cards.map(c => ({
    ...c,
    href: c.href ? new URL(c.href, current).toString() : ""
  }));
  const unique = [...new Map(normalized.map(c => [c.id, c])).values()];

  if (!state.initialized || process.env.BASELINE_ONLY === "true") {
    state.seen = [...new Set([...state.seen, ...unique.map(c => c.id)])].slice(-5000);
    state.initialized = true;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    console.log(`Baseline saved: ${unique.length} visible cards. No notifications sent.`);
  } else {
    const old = new Set(state.seen);
    const fresh = unique.filter(c => !old.has(c.id));
    for (const track of fresh) {
      const message = [
        track.artist && track.title ? `${track.artist} — ${track.title}` : (track.title || track.artist || "Nouvelle soumission"),
        track.href || ""
      ].filter(Boolean).join("\n");
      const body = new URLSearchParams({
        token: process.env.PUSHOVER_API_TOKEN,
        user: process.env.PUSHOVER_USER_KEY,
        title: "Nouvelle soumission SoundCampaign",
        message: message.slice(0, 1024),
        priority: "0"
      });
      const response = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!response.ok) {
        const status = response.status;
        throw new Error(`Pushover notification failed (HTTP ${status}).`);
      }
      console.log(`Pushover notification sent for detected item ${hashForLog(track.id)}.`);
    }
    state.seen = [...new Set([...state.seen, ...unique.map(c => c.id)])].slice(-5000);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    console.log(`Visible cards: ${unique.length}; new cards: ${fresh.length}.`);
  }
  await context.close();
} finally {
  await browser.close();
}

function hashForLog(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10);
}
