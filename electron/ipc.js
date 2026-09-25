// The renderer's whole view of the machine. Each channel does one narrow job;
// file access goes through library.js, which refuses anything outside
// Videos/flight-recorder.

import { app, ipcMain, shell, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isAppUrl } from "./protocols.js";
import { videosDir } from "./paths.js";
import { DEFAULT_WIDTH, DEFAULT_HEIGHT } from "./window-state.js";
import { diagnostics } from "./diagnostics.js";

const ISSUES_URL = "https://github.com/ei-sei/flight-recorder/issues";

// Replies are { ok, value } or { ok: false, error } rather than a rejected
// promise: Electron rewrites a thrown error into "Error invoking remote
// method '...': Error: ...", and these messages reach the user (a failed
// transcription is stored and shown in review), so they should arrive as
// they were written.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isAppUrl(event.senderFrame?.url)) return { ok: false, error: "not allowed" };
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });
}

function windowOf(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw new Error("no window");
  return win;
}

// CI writes build-info.json next to this file; a dev checkout asks git.
function commitSha() {
  try {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "build-info.json"), "utf8")).commit;
  } catch {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  }
}

export function registerIpc({ library, whisper, updater }) {
  // Files and paths
  handle("paths:videoDir", () => videosDir());
  handle("paths:join", (_e, ...parts) => path.join(...parts.map(String)));
  handle("fs:readFile", (_e, target) => library.readFile(target));
  handle("fs:writeFile", (_e, target, bytes) => library.writeFile(target, bytes));
  handle("fs:mkdir", (_e, target, options) => library.mkdir(target, options));
  handle("fs:exists", (_e, target) => library.exists(target));
  handle("fs:remove", (_e, target, options) => library.remove(target, options));
  handle("store:read", (_e, target) => library.readText(target));
  handle("store:write", (_e, target, text) => library.writeTextAtomic(target, String(text)));
  handle("library:size", () => library.size());

  // Window
  handle("window:minimize", (e) => windowOf(e).minimize());
  handle("window:toggleMaximize", (e) => {
    const win = windowOf(e);
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  handle("window:close", (e) => windowOf(e).close());
  handle("window:setAlwaysOnTop", (e, onTop) => windowOf(e).setAlwaysOnTop(Boolean(onTop)));
  handle("window:setSize", (e, width, height) => {
    const win = windowOf(e);
    if (win.isMaximized()) win.unmaximize();
    win.setSize(Math.round(Number(width) || DEFAULT_WIDTH), Math.round(Number(height) || DEFAULT_HEIGHT));
  });

  // App
  handle("app:version", () => app.getVersion());
  handle("app:buildInfo", async () => ({
    Commit: commitSha(),
    Electron: process.versions.electron,
    Chromium: process.versions.chrome,
    "Speech engine": `fr-whisper ${await whisper.version()}`,
  }));
  handle("app:diagnostics", () => diagnostics());

  // Opening things outside the app
  handle("open:revealItem", async (_e, target) => shell.showItemInFolder(await library.inside(target)));
  handle("open:path", async (_e, target) => {
    // Only ever the library folder itself - File > Open recordings folder.
    const real = await library.inside(target);
    if (real !== (await library.inside(library.root))) throw new Error("can only open the recordings folder");
    const error = await shell.openPath(real);
    if (error) throw new Error(error);
  });
  handle("open:url", async (_e, url) => {
    if (url !== ISSUES_URL) throw new Error("can't open that link");
    await shell.openExternal(url);
  });

  // Speech engine
  handle("whisper:present", () => whisper.modelPresent());
  handle("whisper:download", (e) => whisper.downloadModel((progress) => e.sender.send("shell-event", "whisper-download-progress", progress)));
  handle("whisper:transcribe", (_e, pcmPath) => whisper.transcribe(pcmPath));

  // Updates
  handle("updater:check", () => updater.check());
  handle("updater:install", () => updater.install());
}
