// Runs sandboxed, so CommonJS and nothing but Electron's renderer modules.
// Exposes one narrow object to the page; everything it can reach is a
// channel main.js handles and checks.

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = new Set([
  "paths:videoDir",
  "paths:join",
  "fs:readFile",
  "fs:writeFile",
  "fs:mkdir",
  "fs:exists",
  "fs:remove",
  "store:read",
  "store:write",
  "library:size",
  "window:minimize",
  "window:toggleMaximize",
  "window:close",
  "window:setAlwaysOnTop",
  "window:setSize",
  "app:version",
  "app:buildInfo",
  "app:diagnostics",
  "open:revealItem",
  "open:path",
  "open:url",
  "whisper:present",
  "whisper:download",
  "whisper:transcribe",
  "updater:check",
  "updater:install",
]);

contextBridge.exposeInMainWorld("flightRecorder", {
  platform: process.platform,

  // Resolves to { ok, value } or { ok: false, error }.
  call(channel, ...args) {
    if (!CHANNELS.has(channel)) return Promise.resolve({ ok: false, error: `unknown channel ${channel}` });
    return ipcRenderer.invoke(channel, ...args);
  },

  // Events pushed from main (download progress). Returns an unsubscribe.
  on(name, handler) {
    const listener = (_event, eventName, payload) => {
      if (eventName === name) handler(payload);
    };
    ipcRenderer.on("shell-event", listener);
    return () => ipcRenderer.removeListener("shell-event", listener);
  },
});
