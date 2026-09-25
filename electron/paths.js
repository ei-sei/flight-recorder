// Where things live on disk. The two folders below are the same ones the
// Tauri builds used, on purpose: a library and a downloaded speech model from
// before the move to Electron are picked up as they are.

import { app } from "electron";
import os from "node:os";
import path from "node:path";

// The user's Videos folder (~/Movies on macOS). FLIGHT_RECORDER_VIDEOS_DIR
// points it somewhere else for tests, so they never touch a real library.
export function videosDir() {
  return process.env.FLIGHT_RECORDER_VIDEOS_DIR || app.getPath("videos");
}

// Videos/flight-recorder: recordings plus library.json, one portable folder.
export function libraryRoot() {
  return path.join(videosDir(), "flight-recorder");
}

// Tauri's app_data_dir for identifier com.flightrecorder.app. Holds the
// speech model and the pre-portable store. On Linux that's XDG_DATA_HOME
// (~/.local/share), not the ~/.config that Electron's own appData points at.
export function appDataDir() {
  if (process.env.FLIGHT_RECORDER_DATA_DIR) return process.env.FLIGHT_RECORDER_DATA_DIR;
  const base =
    process.platform === "linux"
      ? process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
      : app.getPath("appData");
  return path.join(base, "com.flightrecorder.app");
}

// The fr-whisper speech-to-text helper (native/). Shipped next to the app's
// resources once packaged; from source, whatever `cargo build --release` in
// native/ produced. FR_WHISPER_PATH overrides it for tests.
export function whisperHelperPath() {
  if (process.env.FR_WHISPER_PATH) return process.env.FR_WHISPER_PATH;
  const exe = process.platform === "win32" ? "fr-whisper.exe" : "fr-whisper";
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", exe);
  return path.join(import.meta.dirname, "..", "native", "target", "release", exe);
}
