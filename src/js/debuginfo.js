// Help > Debug info: one plain-text report of what decides how the app
// behaves on this machine, plus its recent errors and activity - what a bug
// report actually needs, in a form that pastes straight into one.
//
// Deliberately leaves out anything the user said or wrote: no transcripts,
// notes or question text. The home folder is shown as ~. Nothing is sent
// anywhere; the user copies it if they choose to.

import { recentLog } from "./diagnostics.js";
import { getVersion, getBuildInfo, getDiagnostics, getLibrarySize, whisperModelPresent } from "./platform.js";
import { getRecordingSettings, getWpmEnabled, getAttempts, getQuestions } from "./store.js";
import { formatBytes, pluralise } from "./util.js";

const LOG_LINES = 60;

async function settled(promise, fallback) {
  try {
    return await promise;
  } catch (err) {
    return `${fallback} (${String(err?.message ?? err)})`;
  }
}

// Device names are only known once the camera has been allowed this session.
// Chromium lists the system default as its own entry labelled just "Default";
// systemDefault is the real device's name where the main process could find
// it (Linux), so the report can say which microphone that actually is.
async function deviceName(kind, id, systemDefault) {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
    const chosen = devices.find((d) => d.deviceId === id && d.deviceId !== "default");
    if (chosen?.label) return chosen.label;
    if (systemDefault) return `${systemDefault} (system default)`;
    const fallback = devices.find((d) => d.deviceId === "default") ?? devices[0];
    if (fallback?.label) return `${fallback.label === "Default" ? "the system's default" : fallback.label} (system default)`;
    return "system default (name shown once the camera has been on)";
  } catch {
    return "unknown";
  }
}

function clock(time) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false });
}

export async function buildDebugReport() {
  const [version, build, system, settings, wpmEnabled, modelPresent, librarySize, questions, attempts] = await Promise.all([
    settled(getVersion(), "unknown"),
    settled(getBuildInfo(), {}),
    settled(getDiagnostics(), {}),
    getRecordingSettings(),
    getWpmEnabled(),
    settled(whisperModelPresent(), "unknown"),
    settled(getLibrarySize(), null),
    getQuestions(),
    getAttempts(),
  ]);
  const [camera, microphone] = await Promise.all([
    deviceName("videoinput", settings.cameraId),
    deviceName("audioinput", settings.micId, typeof system === "object" ? system.defaultMicrophone : null),
  ]);

  const failedTranscriptions = attempts.filter((a) => a.transcriptError);
  const lastFailure = failedTranscriptions[0];
  const home = typeof system === "object" ? system.home : null;
  const redact = (text) => (home ? String(text).split(home).join("~") : String(text));

  const log = [
    ...recentLog().map((e) => ({ time: e.time.toISOString(), level: e.level, source: "ui", text: redact(e.text) })),
    ...((typeof system === "object" && system.log) || []).map((e) => ({ ...e, source: "core" })),
  ]
    .sort((a, b) => a.time.localeCompare(b.time))
    .slice(-LOG_LINES);
  const errors = log.filter((e) => e.level === "error").length;
  const warnings = log.filter((e) => e.level === "warn").length;

  const rows = [
    ["App", `${version} (commit ${build.Commit ?? "unknown"}), ${system.install ?? "unknown install"}`],
    ["Engine", `Electron ${build.Electron ?? "?"}, Chromium ${build.Chromium ?? "?"}, ${build["Speech engine"] ?? "speech engine unknown"}`],
    ["System", system.os ?? "unknown"],
    ...(system.display ? [["Display", system.display]] : []),
    ["Graphics", system.graphics ?? "unknown"],
    ...(system.mangohud ? [["Overlay", system.mangohud]] : []),
    ["Speech pace", `${wpmEnabled ? "on" : "off"}, speech model ${modelPresent === true ? "present" : modelPresent === false ? "not downloaded" : modelPresent}`],
    ["Camera", camera],
    ["Microphone", `${microphone}, gain ${settings.micGainDb > 0 ? `+${settings.micGainDb} dB` : "off"}`],
    ["Recording", `${settings.quality}p`],
    [
      "Library",
      `${pluralise(questions.length, "question")}, ${pluralise(attempts.length, "attempt")}, ${typeof librarySize === "number" ? formatBytes(librarySize) : "size unknown"}`,
    ],
    [
      "Transcription",
      lastFailure
        ? `${pluralise(failedTranscriptions.length, "failure")}; latest (${new Date(lastFailure.date).toLocaleDateString("en-GB")}): ${redact(lastFailure.transcriptError)}`
        : "no failures",
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;

  return [
    "Flight recorder debug info",
    `Generated ${new Date().toLocaleString("en-GB")}`,
    "",
    ...rows.map(([label, value]) => `${`${label}:`.padEnd(width)}${value}`),
    "",
    `Recent log - ${pluralise(errors, "error")}, ${pluralise(warnings, "warning")}, oldest first:`,
    ...(log.length ? log.map((e) => `  ${clock(e.time)} ${e.level.padEnd(5)} ${e.source.padEnd(4)} ${e.text}`) : ["  (nothing logged yet)"]),
  ].join("\n");
}
