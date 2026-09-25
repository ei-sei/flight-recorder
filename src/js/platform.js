// The one place the frontend talks to the desktop shell. Everything that
// touches the filesystem, the window, updates or the speech engine goes
// through here, so the rest of the app doesn't know or care which shell it's
// running in.
//
// The shell is Tauri today and Electron next (window.flightRecorder is what
// the Electron preload exposes). Both are kept behind the same functions so
// each step of that move can be checked against the app as it already works.

const tauri = window.__TAURI__;

// ---- Files and paths -------------------------------------------------------
// Paths are absolute and always inside Videos/flight-recorder - the shell
// refuses anything else.

export function readFile(path) {
  return tauri.fs.readFile(path);
}

export function writeFile(path, bytes) {
  return tauri.fs.writeFile(path, bytes);
}

export function mkdir(path, options) {
  return tauri.fs.mkdir(path, options);
}

export function exists(path) {
  return tauri.fs.exists(path);
}

export function remove(path, options) {
  return tauri.fs.remove(path, options);
}

export function join(...parts) {
  return tauri.path.join(...parts);
}

export function videoDir() {
  return tauri.path.videoDir();
}

// A URL the <video> element can stream a recording from, without reading the
// whole file into memory first.
export function convertFileSrc(path) {
  return tauri.core.convertFileSrc(path);
}

// ---- Settings and library store --------------------------------------------
// Store.load(path) resolves to an object with async get(key), set(key, value)
// and save(). get() resolves to undefined for a key that was never set.
export const Store = {
  load(path) {
    return tauri.store.Store.load(path);
  },
};

// ---- Events from the shell -------------------------------------------------
// handler receives { payload }. Resolves to a function that unsubscribes.
export function listen(event, handler) {
  return tauri.event.listen(event, handler);
}

// ---- Window ----------------------------------------------------------------
function currentWindow() {
  return tauri.window.getCurrentWindow();
}

export function minimizeWindow() {
  return currentWindow().minimize();
}

export function toggleMaximizeWindow() {
  return currentWindow().toggleMaximize();
}

export function closeWindow() {
  return currentWindow().close();
}

export function setAlwaysOnTop(onTop) {
  return currentWindow().setAlwaysOnTop(onTop);
}

// Logical (CSS) pixels, not physical ones.
export function setWindowSize(width, height) {
  return currentWindow().setSize(new tauri.window.LogicalSize(width, height));
}

// direction is one of North, South, East, West, NorthWest, NorthEast,
// SouthWest, SouthEast.
export function startResizeDragging(direction) {
  return currentWindow().startResizeDragging(direction);
}

export function openDevtools() {
  return tauri.core.invoke("open_devtools");
}

// ---- App info and updates --------------------------------------------------
export function getVersion() {
  return tauri.app.getVersion();
}

// Label -> value rows for the About box, beyond the version and platform.
export async function getBuildInfo() {
  const [runtime, commit, rust] = await Promise.all([
    tauri.app.getTauriVersion(),
    tauri.core.invoke("get_commit_sha"),
    tauri.core.invoke("get_rust_version"),
  ]);
  // The compiler that actually built this binary - embedded at compile time
  // from Cargo's own RUSTC env var (see build.rs), not assumed from whatever
  // "rustc" resolves to on whoever's reading this machine.
  return { Commit: commit, Tauri: runtime, Rust: rust };
}

// Resolves to null when up to date, otherwise { version, downloadAndInstall() }.
export function checkForUpdate() {
  return tauri.updater.check();
}

export function relaunch() {
  return tauri.process.relaunch();
}

// ---- Opening things outside the app ----------------------------------------
export function revealItemInDir(path) {
  return tauri.opener.revealItemInDir(path);
}

export function openPath(path) {
  return tauri.opener.openPath(path);
}

export function openUrl(url) {
  return tauri.opener.openUrl(url);
}

// ---- Library and speech engine ---------------------------------------------
// Total bytes under Videos/flight-recorder.
export function getLibrarySize() {
  return tauri.core.invoke("get_library_size");
}

// Asks the filesystem, never a stored flag - see the note in store.js.
export function whisperModelPresent() {
  return tauri.core.invoke("whisper_model_present");
}

// Emits "whisper-download-progress" { downloaded, total | null } while it runs.
export function downloadWhisperModel() {
  return tauri.core.invoke("download_whisper_model");
}

// pcmPath is raw 16kHz mono f32 PCM inside the library; the shell deletes it
// once read. Resolves to { segments: [{ text, start_ms, end_ms, words:
// [{ text, start_ms, end_ms }] }], audio_ms, elapsed_ms, threads, system_info }.
export function transcribeRecording(pcmPath) {
  return tauri.core.invoke("transcribe_recording", { pcmPath });
}
