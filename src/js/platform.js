// The one place the frontend talks to the desktop shell. Everything that
// touches the filesystem, the window, updates or the speech engine goes
// through here, as a call to the Electron main process (electron/ipc.js) via
// the object the preload exposes (electron/preload.cjs).

const shell = window.flightRecorder;

// Rejects with the error as a plain string, written for the user - main
// replies { ok: false, error } rather than throwing, because Electron would
// otherwise prefix every message with "Error invoking remote method". Every
// caller's String(err?.message ?? err) handles a string as it is.
async function call(channel, ...args) {
  const reply = await shell.call(channel, ...args);
  if (!reply.ok) throw reply.error;
  return reply.value;
}

// ---- Files and paths ---------------------------------------------------------
// Paths are absolute and always inside Videos/flight-recorder - main refuses
// anything else.

export function readFile(path) {
  return call("fs:readFile", path);
}

export function writeFile(path, bytes) {
  return call("fs:writeFile", path, bytes);
}

export function mkdir(path, options) {
  return call("fs:mkdir", path, options);
}

export function exists(path) {
  return call("fs:exists", path);
}

export function remove(path, options) {
  return call("fs:remove", path, options);
}

// This OS's path.join, so paths match what main resolves them to.
export function join(...parts) {
  return call("paths:join", ...parts);
}

export function videoDir() {
  return call("paths:videoDir");
}

// A URL the <video> element can stream a recording from, with seeking,
// without reading the whole file into memory first (see electron/protocols.js).
export function convertFileSrc(path) {
  return `media://library/${encodeURIComponent(path)}`;
}

// ---- Settings and library store ----------------------------------------------

// library.json kept in memory and written back whole, as pretty-printed JSON,
// on save(). get/set copy their values, so a caller mutating what it read
// can't change the store behind its back. The Tauri builds wrote the same
// file the same way, so a library from before the move to Electron loads as
// it is.
class LibraryStore {
  constructor(path, data) {
    this.path = path;
    this.data = data;
    this.saving = Promise.resolve();
  }

  async get(key) {
    return Object.hasOwn(this.data, key) ? structuredClone(this.data[key]) : undefined;
  }

  async set(key, value) {
    this.data[key] = structuredClone(value);
  }

  // Serialised, and each save writes the state as of when it was called.
  save() {
    const text = JSON.stringify(this.data, null, 2);
    const write = this.saving.then(() => call("store:write", this.path, text));
    this.saving = write.catch(() => {});
    return write;
  }
}

// Store.load(path) resolves to an object with async get(key), set(key, value)
// and save(). get() resolves to undefined for a key that was never set. A
// relative path is the old pre-portable store in the app-data folder, which
// main only ever lets this read.
export const Store = {
  async load(path) {
    const text = await call("store:read", path);
    const data = text ? JSON.parse(text) : {};
    return new LibraryStore(path, data && typeof data === "object" ? data : {});
  },
};

// ---- Events from the shell ---------------------------------------------------
// handler receives { payload }. Resolves to a function that unsubscribes.
export async function listen(event, handler) {
  return shell.on(event, (payload) => handler({ payload }));
}

// ---- Window ------------------------------------------------------------------
export function minimizeWindow() {
  return call("window:minimize");
}

export function toggleMaximizeWindow() {
  return call("window:toggleMaximize");
}

export function closeWindow() {
  return call("window:close");
}

export function setAlwaysOnTop(onTop) {
  return call("window:setAlwaysOnTop", onTop);
}

// Logical (CSS) pixels, not physical ones.
export function setWindowSize(width, height) {
  return call("window:setSize", width, height);
}


// ---- App info and updates ----------------------------------------------------
export function getVersion() {
  return call("app:version");
}

// Label -> value rows for the About box, beyond the version and platform.
export function getBuildInfo() {
  return call("app:buildInfo");
}

// For Help > Debug info: { install, os, display, graphics, mangohud, home,
// log: [{ time, level, text }] } from the main process, paths shown as ~.
export function getDiagnostics() {
  return call("app:diagnostics");
}

// Resolves to null when up to date, otherwise { version, downloadAndInstall() }.
// Installing quits and restarts the app into the new version by itself.
export async function checkForUpdate() {
  const update = await call("updater:check");
  if (!update) return null;
  return { version: update.version, downloadAndInstall: () => call("updater:install") };
}

// The updater restarts the app itself as part of installing, so there's
// nothing left to do here; kept so the update flow in main.js reads the same.
export async function relaunch() {}

// ---- Opening things outside the app ------------------------------------------
export function revealItemInDir(path) {
  return call("open:revealItem", path);
}

export function openPath(path) {
  return call("open:path", path);
}

export function openUrl(url) {
  return call("open:url", url);
}

// ---- Library and speech engine -----------------------------------------------
// Total bytes under Videos/flight-recorder.
export function getLibrarySize() {
  return call("library:size");
}

// Asks the filesystem, never a stored flag - see the note in store.js.
export function whisperModelPresent() {
  return call("whisper:present");
}

// Emits "whisper-download-progress" { downloaded, total | null } while it runs.
export function downloadWhisperModel() {
  return call("whisper:download");
}

// pcmPath is raw 16kHz mono f32 PCM inside the library; it's deleted once
// read. Resolves to { segments: [{ text, start_ms, end_ms, words:
// [{ text, start_ms, end_ms }] }], audio_ms, elapsed_ms, threads, system_info }.
export function transcribeRecording(pcmPath) {
  return call("whisper:transcribe", pcmPath);
}
