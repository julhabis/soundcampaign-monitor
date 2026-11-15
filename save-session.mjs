import { chromium } from "playwright";
import fs from "node:fs";

const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("https://app.soundcamps.com/", { waitUntil: "domcontentloaded" });
  console.log("Connecte-toi manuellement à SoundCampaign dans le navigateur ouvert.");
  console.log("Quand Tracks Feed est accessible, reviens ici et appuie sur Entrée.");
  await new Promise(resolve => process.stdin.once("data", resolve));
  // Save cookies, localStorage, and IndexedDB-backed authentication state.
  const finalUrl = page.url();
  const pageText = await page.locator("body").innerText().catch(() => "");

  const stillOnLoginPage =
    /\/login(?:[/?#]|$)|\/sign-in(?:[/?#]|$)/i.test(finalUrl) ||
    /Log in as (?:Artist|Playlist Curator|TikTok Creator)/i.test(pageText);

  if (stillOnLoginPage) {
    throw new Error(
      "SoundCampaign is still showing the login page. " +
      "Complete the Playlist Curator login and open the Tracks Feed before saving."
    );
  }

  await context.storageState({
    path: "storage-state.json",
    indexedDB: true,
  });
  fs.chmodSync("storage-state.json", 0o600);
  console.log("Session enregistrée dans storage-state.json. Ne partage pas ce fichier.");
} finally {
  await browser.close();
}
