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
  const alwaysOnTopInput = document.getElementById("always-on-top-input");

  const settings = await getRecordingSettings();
  const { cameras, mics } = await listDevices();

  populateDeviceSelect(cameraSelect, cameras, settings.cameraId, "Camera");
  populateDeviceSelect(micSelect, mics, settings.micId, "Microphone");
  qualitySelect.value = settings.quality;
  alwaysOnTopInput.checked = Boolean(settings.alwaysOnTop);

  overlay.hidden = false;
}

function initSettingsModal() {
  const overlay = document.getElementById("settings-overlay");
  const cameraSelect = document.getElementById("settings-camera");
  const micSelect = document.getElementById("settings-mic");
  const qualitySelect = document.getElementById("settings-quality");
  const alwaysOnTopInput = document.getElementById("always-on-top-input");
  const closeBtn = document.getElementById("settings-close");
  const openFolderBtn = document.getElementById("settings-open-folder");
  const exportBtn = document.getElementById("settings-export");
  const resetBtn = document.getElementById("settings-reset");

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

  alwaysOnTopInput.addEventListener("change", async () => {
    const next = alwaysOnTopInput.checked;
    await appWindow.setAlwaysOnTop(next);
    await saveRecordingSettings({ alwaysOnTop: next });
  });

  openFolderBtn.addEventListener("click", openRecordingsFolder);
  exportBtn.addEventListener("click", exportData);
  resetBtn.addEventListener("click", resetAllData);

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

async function showAboutInfo() {
  const { getVersion } = window.__TAURI__.app;
  const version = await getVersion();
  showAlert({
    title: "About Flight recorder",
    message: `Version ${version}. Automatic update checking isn't set up yet.\n\nA local practice tool for interview questions on webcam — video and data stay on this device except for the opt-in speech-pace (WPM) feature.`,
  });
}

function initTopbarButtons() {
  document.getElementById("settings-btn").addEventListener("click", openSettingsModal);
  document.getElementById("about-btn").addEventListener("click", showAboutInfo);
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
  initTopbarButtons();
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
