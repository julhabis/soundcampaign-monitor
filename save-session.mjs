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
  await context.storageState({ path: "storage-state.json" });
  fs.chmodSync("storage-state.json", 0o600);
  console.log("Session enregistrée dans storage-state.json. Ne partage pas ce fichier.");
} finally {
  await browser.close();
}
