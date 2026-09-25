// The main process's half of Help > Debug info: its recent console output
// (the updater, the speech engine), crashes of Chromium's helper processes -
// a GPU process dying is invisible otherwise, the app just quietly drops to
// software rendering - and the system details that decide how the app
// behaves. Memory only; nothing is written or sent anywhere.

import { app } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ENTRIES = 150;
const MAX_ENTRY_LENGTH = 600;
const entries = [];

function record(level, args) {
  const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : String(a))).join(" ");
  entries.push({ time: new Date().toISOString(), level, text: text.length > MAX_ENTRY_LENGTH ? `${text.slice(0, MAX_ENTRY_LENGTH)}…` : text });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export function captureMainLog() {
  for (const [method, level] of [["error", "error"], ["warn", "warn"], ["info", "info"], ["log", "info"]]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      record(level, args);
      original(...args);
    };
  }
  app.on("child-process-gone", (_event, details) => {
    console.warn(`${details.name ?? details.type} process stopped: ${details.reason}, exit code ${details.exitCode}`);
  });
  app.on("render-process-gone", (_event, _contents, details) => {
    console.error(`The app window's page stopped: ${details.reason}, exit code ${details.exitCode}`);
  });
}

function osName() {
  if (process.platform === "linux") {
    try {
      const release = fs.readFileSync("/etc/os-release", "utf8");
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
      if (pretty) return pretty;
    } catch {
      // fall through
    }
  }
  return `${os.type()} ${os.release()}`;
}

function installKind() {
  if (!app.isPackaged) return "running from source";
  if (process.env.APPIMAGE) return "AppImage";
  try {
    return fs.readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim();
  } catch {
    return { win32: "Windows installer", darwin: "macOS app" }[process.platform] ?? "installed";
  }
}

function display() {
  if (process.platform !== "linux") return null;
  const forced = process.argv.find((arg) => arg.startsWith("--ozone-platform="))?.split("=")[1];
  const session = process.env.XDG_SESSION_TYPE ?? "unknown";
  const desktop = process.env.XDG_CURRENT_DESKTOP ? `, ${process.env.XDG_CURRENT_DESKTOP}` : "";
  return `${forced === "x11" ? "X11 (XWayland)" : forced ?? "default"} on a ${session} session${desktop}`;
}

// Which microphone "system default" actually is. Chromium lists the default
// as its own entry labelled just "Default", with nothing linking it to the
// real device, so on Linux this asks PulseAudio/PipeWire instead. Its
// description matches the label Chromium gives the real device.
function defaultMicrophone() {
  if (process.platform !== "linux") return null;
  try {
    const options = { encoding: "utf8", timeout: 1000 };
    const name = execFileSync("pactl", ["get-default-source"], options).trim();
    const sources = execFileSync("pactl", ["list", "sources"], options);
    const block = sources.split(/\n(?=Source #)/).find((b) => b.includes(`Name: ${name}\n`));
    return /^\s*Description: (.+)$/m.exec(block ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

// Everything is returned with the home folder written as ~, so a pasted
// report doesn't carry the user's account name.
export function diagnostics() {
  const home = os.homedir();
  const redact = (text) => (home ? text.split(home).join("~") : text);
  const gpu = app.getGPUFeatureStatus();
  return {
    install: installKind(),
    os: `${osName()}, ${os.arch()}`,
    display: display(),
    graphics: gpu.gpu_compositing?.startsWith("enabled") ? "hardware accelerated" : "software only - the GPU wasn't usable",
    mangohud: process.env.MANGOHUD && process.env.DISABLE_MANGOHUD === "1" ? "MangoHud is set globally; turned off for this app" : null,
    defaultMicrophone: defaultMicrophone(),
    log: entries.map((entry) => ({ ...entry, text: redact(entry.text) })),
    home,
  };
}
