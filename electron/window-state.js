// Remembers the window's size, position and maximised state between
// launches - what tauri-plugin-window-state did.

import { app, screen } from "electron";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;
export const MIN_WIDTH = 960;
export const MIN_HEIGHT = 640;

function stateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

// A remembered position is only reused if the window would still land on a
// connected display - otherwise unplugging a monitor leaves it off-screen.
function onSomeDisplay({ x, y, width, height }) {
  return screen.getAllDisplays().some(({ workArea: area }) => {
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    return overlapX >= 100 && overlapY >= 50;
  });
}

export function loadWindowState() {
  const fallback = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const width = Math.max(MIN_WIDTH, Number(saved.width) || DEFAULT_WIDTH);
    const height = Math.max(MIN_HEIGHT, Number(saved.height) || DEFAULT_HEIGHT);
    const state = { width, height, maximized: Boolean(saved.maximized) };
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && onSomeDisplay({ x: saved.x, y: saved.y, width, height })) {
      state.x = saved.x;
      state.y = saved.y;
    }
    return state;
  } catch {
    return fallback;
  }
}

export function trackWindowState(win) {
  win.on("close", () => {
    try {
      // Normal bounds, so a window closed while maximised comes back
      // maximised over the size it had before, not stuck at full screen size.
      const bounds = win.getNormalBounds();
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
    } catch (err) {
      console.error("Couldn't save the window state", err);
    }
  });
}
