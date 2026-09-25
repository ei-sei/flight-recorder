// Locks the renderer down to what the app actually uses. The UI is our own
// code, but it renders transcripts and notes, and everything here costs
// nothing to keep closed.

import { app, session } from "electron";
import { isAppUrl } from "./protocols.js";

// Camera and mic, About -> Copy (clipboard), and the review player's own
// fullscreen button. Nothing else is asked for, and nothing else is granted.
const ALLOWED_PERMISSIONS = new Set(["media", "clipboard-sanitized-write", "fullscreen"]);

export function lockDownSession(ses = session.defaultSession) {
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl ?? webContents.getURL()));
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin);
  });
  // WebUSB / WebHID / serial - none of it is used.
  ses.setDevicePermissionHandler(() => false);

  // The app touches the network in exactly two places - the opt-in speech
  // model download and update checks - and both run in the main process, not
  // here. Blocking the renderer outright makes that promise enforced rather
  // than merely true of today's code.
  ses.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      console.warn(`Blocked a network request from the UI: ${details.url}`);
      callback({ cancel: true });
    }
  );

  // Chromium downloads Hunspell dictionaries from Google on Windows and
  // Linux the first time spellcheck runs - a network call nobody asked for.
  // macOS uses the system spellchecker and downloads nothing, so it keeps it.
  if (process.platform !== "darwin") ses.setSpellCheckerEnabled(false);

  ses.on("will-download", (event) => event.preventDefault());
}

// Every window and webview the app ever creates gets the same rules.
export function lockDownNavigation() {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    // Links out of the app go through openUrl, which checks them.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

export function webPreferencesFor(preload) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    spellcheck: process.platform === "darwin",
    // The recording-mode probe and the level meter both start audio before
    // anyone has clicked; this is a desktop app, not a page that might
    // autoplay an advert.
    autoplayPolicy: "no-user-gesture-required",
  };
}
