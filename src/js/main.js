import { initQuestions, getSelectedQuestion, selectQuestionById } from "./questions.js";
import {
  initRecorder,
  setRecordEnabled,
  enterReviewMode,
  exitReviewMode,
  listDevices,
  applyRecordingSettings,
} from "./recorder.js";
import {
  initAttempts,
  saveAttempt,
  clearReviewing,
  setSelectedQuestion,
  updateAttemptNotes,
  updateAttemptScore,
} from "./attempts.js";
import {
  getQuestions,
  getAttempts,
  getRecordingSettings,
  saveRecordingSettings,
  clearAllData,
} from "./store.js";
import { showAlert, showConfirm } from "./modal.js";
import { showContextMenu } from "./contextmenu.js";

const clockEl = document.getElementById("clock");
const currentQuestionEl = document.getElementById("current-question");

let appWindow = null;

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}

function handleQuestionSelectionChange(question) {
  currentQuestionEl.textContent = question ? question.text : "Select a question to begin.";
  setRecordEnabled(Boolean(question));
  setSelectedQuestion(question);
}

function populateDeviceSelect(select, devices, selectedId, kindLabel) {
  select.innerHTML = "";
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${kindLabel} (${device.deviceId.slice(0, 6)})`;
    select.appendChild(option);
  }
  if (selectedId && devices.some((d) => d.deviceId === selectedId)) {
    select.value = selectedId;
  }
}

async function openRecordingsFolder() {
  const { videoDir, join } = window.__TAURI__.path;
  const { mkdir } = window.__TAURI__.fs;
  const { openPath } = window.__TAURI__.opener;

  const dir = await join(await videoDir(), "flight-recorder");
  await mkdir(dir, { recursive: true });
  await openPath(dir);
}

async function exportData() {
  const { videoDir, join } = window.__TAURI__.path;
  const { mkdir, writeFile } = window.__TAURI__.fs;
  const { revealItemInDir } = window.__TAURI__.opener;

  const questions = await getQuestions();
  const attempts = await getAttempts();
  const data = { exportedAt: new Date().toISOString(), questions, attempts };

  const dir = await join(await videoDir(), "flight-recorder");
  await mkdir(dir, { recursive: true });
  const filename = `export-${new Date().toISOString().slice(0, 10)}.json`;
  const filePath = await join(dir, filename);
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
  await writeFile(filePath, bytes);

  const showInFolder = await showConfirm({
    title: "Data exported",
    message: `Saved as ${filename} in your recordings folder.`,
    confirmLabel: "Show in folder",
  });
  if (showInFolder) revealItemInDir(filePath);
}

async function resetAllData() {
  const confirmed = await showConfirm({
    title: "Reset all data?",
    message: "This deletes every question, every attempt, and every recorded video. This can't be undone.",
    confirmLabel: "Reset everything",
    danger: true,
  });
  if (!confirmed) return;

  const { videoDir, join } = window.__TAURI__.path;
  const { remove, exists } = window.__TAURI__.fs;

  const dir = await join(await videoDir(), "flight-recorder");
  if (await exists(dir)) {
    await remove(dir, { recursive: true });
  }
  await clearAllData();
  location.reload();
}

async function openSettingsModal() {
  const overlay = document.getElementById("settings-overlay");
  const cameraSelect = document.getElementById("settings-camera");
  const micSelect = document.getElementById("settings-mic");
  const qualitySelect = document.getElementById("settings-quality");

  const settings = await getRecordingSettings();
  const { cameras, mics } = await listDevices();

  populateDeviceSelect(cameraSelect, cameras, settings.cameraId, "Camera");
  populateDeviceSelect(micSelect, mics, settings.micId, "Microphone");
  qualitySelect.value = settings.quality;

  overlay.hidden = false;
}

function initSettingsModal() {
  const overlay = document.getElementById("settings-overlay");
  const cameraSelect = document.getElementById("settings-camera");
  const micSelect = document.getElementById("settings-mic");
  const qualitySelect = document.getElementById("settings-quality");
  const closeBtn = document.getElementById("settings-close");

  async function applyDeviceChange() {
    await applyRecordingSettings({
      cameraId: cameraSelect.value || null,
      micId: micSelect.value || null,
      quality: qualitySelect.value,
    });
  }

  cameraSelect.addEventListener("change", applyDeviceChange);
  micSelect.addEventListener("change", applyDeviceChange);
  qualitySelect.addEventListener("change", applyDeviceChange);

  closeBtn.addEventListener("click", () => {
    overlay.hidden = true;
  });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) overlay.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) overlay.hidden = true;
  });
}

async function showUpdatesInfo() {
  const { getVersion } = window.__TAURI__.app;
  const version = await getVersion();
  showAlert({
    title: "Updates",
    message: `You're on version ${version}. Automatic update checking isn't set up yet.`,
  });
}

async function showAboutInfo() {
  const { getVersion } = window.__TAURI__.app;
  const version = await getVersion();
  showAlert({
    title: "About Flight recorder",
    message: `Version ${version}. A local practice tool for interview questions on webcam — video and data stay on this device except for the opt-in speech-pace (WPM) feature.`,
  });
}

function openMenu(button, items) {
  const rect = button.getBoundingClientRect();
  showContextMenu(rect.left, rect.bottom + 4, items);
}

function initMenuBar() {
  const fileBtn = document.getElementById("menu-file");
  const viewBtn = document.getElementById("menu-view");
  const helpBtn = document.getElementById("menu-help");

  fileBtn.addEventListener("click", () => {
    openMenu(fileBtn, [
      { label: "Settings", onClick: openSettingsModal },
      { label: "Open recordings folder", onClick: openRecordingsFolder },
      { label: "Export data", onClick: exportData },
      { label: "Reset all data", danger: true, onClick: resetAllData },
    ]);
  });

  viewBtn.addEventListener("click", async () => {
    const settings = await getRecordingSettings();
    openMenu(viewBtn, [
      {
        label: settings.alwaysOnTop ? "Always on top ✓" : "Always on top",
        onClick: async () => {
          const next = !settings.alwaysOnTop;
          await appWindow.setAlwaysOnTop(next);
          await saveRecordingSettings({ alwaysOnTop: next });
        },
      },
    ]);
  });

  helpBtn.addEventListener("click", () => {
    openMenu(helpBtn, [
      { label: "Check for updates", onClick: showUpdatesInfo },
      { label: "About", onClick: showAboutInfo },
    ]);
  });
}

function initWindowControls() {
  const { getCurrentWindow } = window.__TAURI__.window;
  appWindow = getCurrentWindow();

  document.getElementById("win-minimize").addEventListener("click", () => appWindow.minimize());
  document.getElementById("win-maximize").addEventListener("click", () => appWindow.toggleMaximize());
  document.getElementById("win-close").addEventListener("click", () => appWindow.close());

  for (const handle of document.querySelectorAll(".resize-handle")) {
    handle.addEventListener("mousedown", (event) => {
      if (event.buttons === 1) {
        appWindow.startResizeDragging(handle.dataset.resizeDir);
      }
    });
  }
}

async function init() {
  tickClock();
  setInterval(tickClock, 1000);
  initWindowControls();
  initMenuBar();
  initSettingsModal();

  const settings = await getRecordingSettings();
  if (settings.alwaysOnTop) {
    await appWindow.setAlwaysOnTop(true);
  }

  await initAttempts({
    onPlay: (attempt, attemptNumber) => {
      selectQuestionById(attempt.questionId);
      enterReviewMode(attempt, attemptNumber);
    },
    onExitReview: exitReviewMode,
  });
  await initQuestions({ onSelectionChange: handleQuestionSelectionChange });
  await initRecorder({
    getSelectedQuestion,
    onRecordingComplete: saveAttempt,
    onExitReview: () => {
      handleQuestionSelectionChange(getSelectedQuestion());
      clearReviewing();
    },
    onNotesChange: updateAttemptNotes,
    onScoreChange: updateAttemptScore,
  });
}

init();
