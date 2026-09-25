// Runs a packaged build for a few seconds - fresh profile, throwaway library -
// and fails if it contacted anything other than this repository on GitHub
// (its update check):
//   node scripts/check-network.js dist/flight-recorder-<version>.AppImage
//
// The app promises the network is used for exactly two things: the opt-in
// speech model download and update checks. The end-to-end test checks this
// from source, but updates only run in an installed build - and that is
// where a leak was found: electron-updater's own session downloaded a
// spellcheck dictionary from Google. Hence this check, on the real package.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED = /^https:\/\/github\.com\/ei-sei\/flight-recorder\//;
const RUN_MS = 12_000;

const app = process.argv[2];
if (!app) {
  console.error("usage: node scripts/check-network.js <packaged app>");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-network-"));
const netlog = path.join(tmp, "netlog.json");
const profile = path.join(tmp, "profile");
const env = {
  ...process.env,
  FLIGHT_RECORDER_USER_DATA_DIR: profile,
  FLIGHT_RECORDER_VIDEOS_DIR: path.join(tmp, "Videos"),
  FLIGHT_RECORDER_DATA_DIR: path.join(tmp, "data"),
  // CI runners may have no FUSE; unpacking works everywhere.
  APPIMAGE_EXTRACT_AND_RUN: "1",
};
delete env.MANGOHUD;
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(path.resolve(app), ["--ozone-platform=x11", `--log-net-log=${netlog}`], {
  env,
  stdio: "ignore",
  detached: true,
});
await new Promise((resolve) => setTimeout(resolve, RUN_MS));
const exited = new Promise((resolve) => child.on("exit", resolve));
process.kill(-child.pid, "SIGTERM");
await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
try {
  process.kill(-child.pid, "SIGKILL");
} catch {
  // already gone
}

// A netlog cut short by the kill is still readable line by line.
const text = fs.existsSync(netlog) ? fs.readFileSync(netlog, "utf8") : "";
if (!text) {
  console.error("no netlog was written - did the app start?");
  process.exit(1);
}
const urls = [...new Set([...text.matchAll(/"url":"((?:https?|wss?):\/\/[^"]+)"/g)].map((m) => m[1]))];
const unexpected = urls.filter((url) => !ALLOWED.test(url));
const dictionaries = fs.existsSync(path.join(profile, "Dictionaries")) ? fs.readdirSync(path.join(profile, "Dictionaries")) : [];

console.log(`requests: ${urls.length ? urls.join(", ") : "none"}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (unexpected.length || dictionaries.length) {
  console.error(`unexpected network use: ${[...unexpected, ...dictionaries.map((d) => `dictionary ${d}`)].join(", ")}`);
  process.exit(1);
}
console.log("ok: only the update check");
