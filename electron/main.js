// Electron main process. The order at the top matters: everything before
// app.whenReady() has to run synchronously on the very first tick, or it's
// too late to take effect.

import { app, BrowserWindow, protocol } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";

import { libraryRoot, appDataDir, whisperHelperPath } from "./paths.js";
import { createLibrary } from "./library.js";
import { createWhisper } from "./whisper.js";
import { createAppHandler, createMediaHandler, APP_ORIGIN } from "./protocols.js";
import { lockDownSession, lockDownNavigation, webPreferencesFor } from "./security.js";
import { loadWindowState, trackWindowState, MIN_WIDTH, MIN_HEIGHT } from "./window-state.js";
import { registerIpc } from "./ipc.js";
import { createUpdater } from "./updater.js";

const SRC_DIR = path.join(import.meta.dirname, "..", "src");

// Two things can only be set before Chromium starts, which is before this
// script runs - so when either is missing, the app relaunches itself once
// with it in place. The installed launchers pass both up front (see
// electron-builder.yml), so this only costs anything when started some other
// way.
//
// - Linux runs through XWayland (X11), as the Tauri builds did. Native
//   Wayland can't do always-on-top, restore a window's position, or resize a
//   window from code (View > Reset view). app.commandLine.appendSwitch() is
//   too late for this one: the window has already been created on Wayland by
//   then, and only the helper processes switch. An explicit --ozone-platform
//   on the command line still wins, for testing native Wayland.
// - MangoHud (a gaming overlay) set globally with MANGOHUD=1 loads itself
//   into every Vulkan program, including Chromium's GPU process - where it
//   crashes, and the app silently drops to software rendering. The GPU
//   process is forked from a helper Chromium starts before this script, so
//   setting DISABLE_MANGOHUD here reaches it too late.
function relaunchIfNeeded() {
  // process.argv, not app.commandLine: Electron fills in its own
  // --ozone-platform (wayland, on a Wayland desktop) before this runs, so
  // app.commandLine always reports the switch as set.
  const explicitOzone = process.argv.some((arg) => arg === "--ozone-platform" || arg.startsWith("--ozone-platform="));
  const needsX11 = process.platform === "linux" && !explicitOzone;
  const needsMangoHudOff = Boolean(process.env.MANGOHUD) && process.env.DISABLE_MANGOHUD !== "1";
  if (!needsX11 && !needsMangoHudOff) return false;

  const env = { ...process.env };
  if (needsMangoHudOff) env.DISABLE_MANGOHUD = "1";
  const args = process.argv.slice(1);
  if (needsX11) args.push("--ozone-platform=x11");
  // Started directly rather than with app.relaunch(). Inside an AppImage,
  // app.relaunch's helper runs from the AppImage's mount, which disappears
  // the moment this process exits - taking the helper with it, so the app
  // never came back. That includes the restart after an update, which
  // arrives without the X11 flag. Safe to overlap: nothing has taken the
  // single-instance lock or opened a window yet.
  const child = spawn(process.env.APPIMAGE || process.execPath, args, { env, detached: true, stdio: "ignore" });
  child.unref();
  app.exit(0);
  return true;
}

function start() {
  // Chromium's own profile (caches, localStorage, window state). Tests point
  // it at a throwaway folder so every run starts as a fresh install would.
  if (process.env.FLIGHT_RECORDER_USER_DATA_DIR) app.setPath("userData", process.env.FLIGHT_RECORDER_USER_DATA_DIR);

  // Both schemes in one call - it can only be made once, before ready.
  // `standard` gives app:// a real origin (localStorage, permissions, relative
  // URLs); `secure` makes it a secure context, which getUserMedia requires.
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    { scheme: "media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);

  app.enableSandbox();
  lockDownNavigation();

  let mainWindow = null;

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // A second launch brings the running window forward instead of opening
  // another copy fighting over the same camera and library.json.
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    const library = createLibrary({
      root: libraryRoot(),
      legacyStoreFile: path.join(appDataDir(), "flight-recorder.json"),
    });
    const whisper = createWhisper({ modelDir: appDataDir(), helperPath: whisperHelperPath(), library });
    app.on("will-quit", () => whisper.stop());

    lockDownSession();
    protocol.handle("app", createAppHandler(SRC_DIR));
    protocol.handle("media", createMediaHandler(library));
    registerIpc({ library, whisper, updater: createUpdater() });

    const state = loadWindowState();
    mainWindow = new BrowserWindow({
      ...state,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      // The app draws its own title bar (see .topbar and the window controls).
      frame: false,
      roundedCorners: false,
      show: false,
      title: "Flight recorder",
      // Set explicitly for Linux, where the window doesn't pick up the
      // installed launcher's icon by itself.
      icon: path.join(import.meta.dirname, "icon.png"),
      webPreferences: webPreferencesFor(path.join(import.meta.dirname, "preload.cjs")),
    });
    if (state.maximized) mainWindow.maximize();
    trackWindowState(mainWindow);
    // Shown once painted, so launch doesn't flash an empty frame first.
    mainWindow.once("ready-to-show", () => mainWindow.show());
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  });

  app.on("window-all-closed", () => app.quit());
}

if (!relaunchIfNeeded()) start();
