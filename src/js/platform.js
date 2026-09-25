// The one place the frontend talks to the desktop shell. Everything that
// touches the filesystem, the window, updates or the speech engine goes
// through here, so the rest of the app doesn't know or care which shell it's
// running in.
//
// Two shells are supported while the app moves from Tauri to Electron:
// window.flightRecorder is what the Electron preload exposes, and
// window.__TAURI__ is Tauri's. Both sit behind the same functions, so each
// step of the move can be checked against the app as it already works.

const electron = window.flightRecorder;
const tauri = window.__TAURI__;

// Lets CSS tell the shells apart (the title bar drags differently in each).
document.documentElement.dataset.shell = electron ? "electron" : "tauri";

// ---- Electron ----------------------------------------------------------------

// Rejects with the error as a plain string - the same shape Tauri's invoke
// rejected with, which is what every caller's String(err?.message ?? err)
// already handles.
async function call(channel, ...args) {
  const reply = await electron.call(channel, ...args);
  if (!reply.ok) throw reply.error;
  return reply.value;
}

// library.json kept in memory and written back whole, as pretty-printed JSON,
// on save(). get/set copy their values, so a caller mutating what it read
// can't change the store behind its back - Tauri's store (which this
// replaces, on the same file) handed out fresh copies too.
class ElectronStore {
  constructor(path, data) {
    this.path = path;
    this.data = data;
    this.saving = Promise.resolve();
  }

  // A relative path is the old pre-portable store in the app-data folder,
  // which main only ever lets us read.
  static async load(path) {
    const text = await call("store:read", path);
    const data = text ? JSON.parse(text) : {};
    return new ElectronStore(path, data && typeof data === "object" ? data : {});
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

const electronShell = {
  readFile: (path) => call("fs:readFile", path),
  writeFile: (path, bytes) => call("fs:writeFile", path, bytes),
  mkdir: (path, options) => call("fs:mkdir", path, options),
  exists: (path) => call("fs:exists", path),
  remove: (path, options) => call("fs:remove", path, options),
  join: (...parts) => call("paths:join", ...parts),
  videoDir: () => call("paths:videoDir"),
  convertFileSrc: (path) => `media://library/${encodeURIComponent(path)}`,
  loadStore: (path) => ElectronStore.load(path),
  listen: async (event, handler) => electron.on(event, (payload) => handler({ payload })),
  minimizeWindow: () => call("window:minimize"),
  toggleMaximizeWindow: () => call("window:toggleMaximize"),
  closeWindow: () => call("window:close"),
  setAlwaysOnTop: (onTop) => call("window:setAlwaysOnTop", onTop),
  setWindowSize: (width, height) => call("window:setSize", width, height),
  // Electron resizes a frameless window from its edges by itself, so the
  // app's own resize handles are hidden there (see style.css).
  startResizeDragging: async () => {},
  openDevtools: () => call("window:devtools"),
  getVersion: () => call("app:version"),
  getBuildInfo: () => call("app:buildInfo"),
  checkForUpdate: async () => {
    const update = await call("updater:check");
    if (!update) return null;
    return { version: update.version, downloadAndInstall: () => call("updater:install") };
  },
  // Electron's updater restarts the app itself as part of installing.
  relaunch: async () => {},
  revealItemInDir: (path) => call("open:revealItem", path),
  openPath: (path) => call("open:path", path),
  openUrl: (url) => call("open:url", url),
  getLibrarySize: () => call("library:size"),
  whisperModelPresent: () => call("whisper:present"),
  downloadWhisperModel: () => call("whisper:download"),
  transcribeRecording: (pcmPath) => call("whisper:transcribe", pcmPath),
};

// ---- Tauri -------------------------------------------------------------------

function tauriWindow() {
  return tauri.window.getCurrentWindow();
}

const tauriShell = tauri && {
  readFile: (path) => tauri.fs.readFile(path),
  writeFile: (path, bytes) => tauri.fs.writeFile(path, bytes),
  mkdir: (path, options) => tauri.fs.mkdir(path, options),
  exists: (path) => tauri.fs.exists(path),
  remove: (path, options) => tauri.fs.remove(path, options),
  join: (...parts) => tauri.path.join(...parts),
  videoDir: () => tauri.path.videoDir(),
  convertFileSrc: (path) => tauri.core.convertFileSrc(path),
  loadStore: (path) => tauri.store.Store.load(path),
  listen: (event, handler) => tauri.event.listen(event, handler),
  minimizeWindow: () => tauriWindow().minimize(),
  toggleMaximizeWindow: () => tauriWindow().toggleMaximize(),
  closeWindow: () => tauriWindow().close(),
  setAlwaysOnTop: (onTop) => tauriWindow().setAlwaysOnTop(onTop),
  setWindowSize: (width, height) => tauriWindow().setSize(new tauri.window.LogicalSize(width, height)),
  startResizeDragging: (direction) => tauriWindow().startResizeDragging(direction),
  openDevtools: () => tauri.core.invoke("open_devtools"),
  getVersion: () => tauri.app.getVersion(),
  getBuildInfo: async () => {
    const [runtime, commit, rust] = await Promise.all([
      tauri.app.getTauriVersion(),
      tauri.core.invoke("get_commit_sha"),
      tauri.core.invoke("get_rust_version"),
    ]);
    // The compiler that actually built this binary - embedded at compile
    // time from Cargo's own RUSTC env var (see build.rs), not assumed from
    // whatever "rustc" resolves to on whoever's reading this machine.
    return { Commit: commit, Tauri: runtime, Rust: rust };
  },
  checkForUpdate: () => tauri.updater.check(),
  relaunch: () => tauri.process.relaunch(),
  revealItemInDir: (path) => tauri.opener.revealItemInDir(path),
  openPath: (path) => tauri.opener.openPath(path),
  openUrl: (url) => tauri.opener.openUrl(url),
  getLibrarySize: () => tauri.core.invoke("get_library_size"),
  whisperModelPresent: () => tauri.core.invoke("whisper_model_present"),
  downloadWhisperModel: () => tauri.core.invoke("download_whisper_model"),
  transcribeRecording: (pcmPath) => tauri.core.invoke("transcribe_recording", { pcmPath }),
};

const shell = electron ? electronShell : tauriShell;

// ---- Files and paths ---------------------------------------------------------
// Paths are absolute and always inside Videos/flight-recorder - the shell
// refuses anything else.

export function readFile(path) {
  return shell.readFile(path);
}

export function writeFile(path, bytes) {
  return shell.writeFile(path, bytes);
}

export function mkdir(path, options) {
  return shell.mkdir(path, options);
}

export function exists(path) {
  return shell.exists(path);
}

export function remove(path, options) {
  return shell.remove(path, options);
}

export function join(...parts) {
  return shell.join(...parts);
}

export function videoDir() {
  return shell.videoDir();
}

// A URL the <video> element can stream a recording from, without reading the
// whole file into memory first.
export function convertFileSrc(path) {
  return shell.convertFileSrc(path);
}

// ---- Settings and library store ----------------------------------------------
// Store.load(path) resolves to an object with async get(key), set(key, value)
// and save(). get() resolves to undefined for a key that was never set.
export const Store = {
  load(path) {
    return shell.loadStore(path);
  },
};

// ---- Events from the shell ---------------------------------------------------
// handler receives { payload }. Resolves to a function that unsubscribes.
export function listen(event, handler) {
  return shell.listen(event, handler);
}

// ---- Window ------------------------------------------------------------------
export function minimizeWindow() {
  return shell.minimizeWindow();
}

export function toggleMaximizeWindow() {
  return shell.toggleMaximizeWindow();
}

export function closeWindow() {
  return shell.closeWindow();
}

export function setAlwaysOnTop(onTop) {
  return shell.setAlwaysOnTop(onTop);
}

// Logical (CSS) pixels, not physical ones.
export function setWindowSize(width, height) {
  return shell.setWindowSize(width, height);
}

// direction is one of North, South, East, West, NorthWest, NorthEast,
// SouthWest, SouthEast.
export function startResizeDragging(direction) {
  return shell.startResizeDragging(direction);
}

export function openDevtools() {
  return shell.openDevtools();
}

// ---- App info and updates ----------------------------------------------------
export function getVersion() {
  return shell.getVersion();
}

// Label -> value rows for the About box, beyond the version and platform.
export function getBuildInfo() {
  return shell.getBuildInfo();
}

// Resolves to null when up to date, otherwise { version, downloadAndInstall() }.
export function checkForUpdate() {
  return shell.checkForUpdate();
}

export function relaunch() {
  return shell.relaunch();
}

// ---- Opening things outside the app ------------------------------------------
export function revealItemInDir(path) {
  return shell.revealItemInDir(path);
}

export function openPath(path) {
  return shell.openPath(path);
}

export function openUrl(url) {
  return shell.openUrl(url);
}

// ---- Library and speech engine -----------------------------------------------
// Total bytes under Videos/flight-recorder.
export function getLibrarySize() {
  return shell.getLibrarySize();
}

// Asks the filesystem, never a stored flag - see the note in store.js.
export function whisperModelPresent() {
  return shell.whisperModelPresent();
}

// Emits "whisper-download-progress" { downloaded, total | null } while it runs.
export function downloadWhisperModel() {
  return shell.downloadWhisperModel();
}

// pcmPath is raw 16kHz mono f32 PCM inside the library; the shell deletes it
// once read. Resolves to { segments: [{ text, start_ms, end_ms, words:
// [{ text, start_ms, end_ms }] }], audio_ms, elapsed_ms, threads, system_info }.
export function transcribeRecording(pcmPath) {
  return shell.transcribeRecording(pcmPath);
}
