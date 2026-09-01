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
  recoverOrphanedVideos,
} from "./attempts.js";
import {
  getQuestions,
  getAttempts,
  getRecordingSettings,
  saveRecordingSettings,
  clearAllData,
  getTheme,
  setTheme,
} from "./store.js";
import { showAlert, showConfirm } from "./modal.js";
import { showContextMenu, hideContextMenu, isContextMenuVisible } from "./contextmenu.js";

const clockEl = document.getElementById("clock");
const currentQuestionEl = document.getElementById("current-question");

let appWindow = null;

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  try {
    localStorage.setItem("theme", theme);
  } catch (err) {
    // localStorage unavailable; the Tauri store remains the source of truth
  }
}

function isSidebarVisible() {
  try {
    return localStorage.getItem("sidebarVisible") !== "false";
  } catch (err) {
    return true;
  }
}

function setSidebarVisible(visible) {
  document.querySelector(".layout").classList.toggle("sidebar-hidden", !visible);
  try {
    localStorage.setItem("sidebarVisible", String(visible));
  } catch (err) {
    // localStorage unavailable; state just won't persist across launches
  }
}

function initSidebar() {
  setSidebarVisible(isSidebarVisible());

  document.getElementById("rail-questions").addEventListener("click", () => {
    setSidebarVisible(!isSidebarVisible());
  });
}

function isLogPanelVisible() {
  try {
    return localStorage.getItem("logPanelVisible") !== "false";
  } catch (err) {
    return true;
  }
}

function setLogPanelVisible(visible) {
  document.querySelector(".layout").classList.toggle("log-hidden", !visible);
  try {
    localStorage.setItem("logPanelVisible", String(visible));
  } catch (err) {
    // localStorage unavailable; state just won't persist across launches
  }
}

function initLogPanelToggle() {
  setLogPanelVisible(isLogPanelVisible());

  document.getElementById("rail-log").addEventListener("click", () => {
    setLogPanelVisible(!isLogPanelVisible());
  });
}

function initPanelResize() {
  const layoutEl = document.querySelector(".layout");
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 500;
  const SIDEBAR_DEFAULT = 257;
  const LOG_MIN = 260;
  const LOG_MAX = 600;
  const LOG_DEFAULT = 299;

  function getStoredWidth(key, fallback) {
    try {
      const value = parseInt(localStorage.getItem(key), 10);
      return Number.isFinite(value) ? value : fallback;
    } catch (err) {
      return fallback;
    }
  }

  let sidebarWidth = getStoredWidth("sidebarWidthPx", SIDEBAR_DEFAULT);
  let logWidth = getStoredWidth("logWidthPx", LOG_DEFAULT);

  function applyWidths() {
    layoutEl.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
    layoutEl.style.setProperty("--log-w", `${logWidth}px`);
  }
  applyWidths();

  function startDrag(target, handleEl, startEvent) {
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const startSidebar = sidebarWidth;
    const startLog = logWidth;
    handleEl.classList.add("dragging");

    function onMove(moveEvent) {
      const deltaX = moveEvent.clientX - startX;
      if (target === "sidebar") {
        sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startSidebar + deltaX));
      } else {
        logWidth = Math.min(LOG_MAX, Math.max(LOG_MIN, startLog - deltaX));
      }
      applyWidths();
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      handleEl.classList.remove("dragging");
      try {
        localStorage.setItem("sidebarWidthPx", String(sidebarWidth));
        localStorage.setItem("logWidthPx", String(logWidth));
      } catch (err) {
        // localStorage unavailable; sizes just won't persist across launches
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const sidebarHandle = document.getElementById("resize-sidebar");
  const logHandle = document.getElementById("resize-log");
  sidebarHandle.addEventListener("mousedown", (event) => startDrag("sidebar", sidebarHandle, event));
  logHandle.addEventListener("mousedown", (event) => startDrag("log", logHandle, event));

  resetPanelWidths = () => {
    sidebarWidth = SIDEBAR_DEFAULT;
    logWidth = LOG_DEFAULT;
    applyWidths();
    try {
      localStorage.removeItem("sidebarWidthPx");
      localStorage.removeItem("logWidthPx");
    } catch (err) {
      // localStorage unavailable; nothing to clear
    }
  };
}

let resetPanelWidths = () => {};

function resetView() {
  resetPanelWidths();
  setSidebarVisible(true);
  setLogPanelVisible(true);
  setRailVisible(true);
}

function isRailVisible() {
  try {
    return localStorage.getItem("railVisible") === "true";
  } catch (err) {
    return false;
  }
}

function setRailVisible(visible) {
  document.getElementById("activity-rail").hidden = !visible;
  try {
    localStorage.setItem("railVisible", String(visible));
  } catch (err) {
    // localStorage unavailable; state just won't persist across launches
  }
}

function initRail() {
  setRailVisible(isRailVisible());
}

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}

function handleQuestionSelectionChange(question) {
  // No-ops if not currently reviewing (including the reverse path, where
  // onPlay selects the attempt's question before entering review mode -
  // isReviewing is still false at that point). Picking a different question
  // from the sidebar while reviewing an attempt should return to the live
  // camera view instead of leaving the reviewed video showing.
  exitReviewMode();
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

  let filename, filePath;
  try {
    const questions = await getQuestions();
    const attempts = await getAttempts();
    const data = { exportedAt: new Date().toISOString(), questions, attempts };

    const dir = await join(await videoDir(), "flight-recorder");
    await mkdir(dir, { recursive: true });
    filename = `export-${new Date().toISOString().slice(0, 10)}.json`;
    filePath = await join(dir, filename);
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    await writeFile(filePath, bytes);
  } catch (err) {
    console.error("Export data failed", err);
    await showAlert({ title: "Export failed", message: String(err?.message ?? err) });
    return;
  }

  const showInFolder = await showConfirm({
    title: "Data exported",
    message: `Saved as ${filename} in your recordings folder.`,
    confirmLabel: "Show in folder",
  });
  if (showInFolder) revealItemInDir(filePath);
}

async function recoverVideos() {
  let count;
  try {
    count = await recoverOrphanedVideos();
  } catch (err) {
    console.error("Recover orphaned videos failed", err);
    await showAlert({ title: "Recovery failed", message: String(err?.message ?? err) });
    return;
  }

  if (count === 0) {
    await showAlert({
      title: "Recover videos",
      message: "No orphaned videos found - every video file on disk is already linked to an attempt.",
    });
    return;
  }

  await showAlert({
    title: "Recover videos",
    message: `Recovered ${count} video${count === 1 ? "" : "s"}. The original question couldn't be recovered (it was never stored anywhere but the app data that got wiped), so they show up unlinked - you can still review, score, and add notes to them.`,
  });
}

async function resetAllData() {
  const confirmed = await showConfirm({
    title: "Reset all data?",
    message: "This deletes every question, every attempt, and every recorded video. This can't be undone.",
    confirmLabel: "Reset everything",
    danger: true,
    requireTypedWord: "DELETE",
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
  const { check } = window.__TAURI__.updater;
  const { relaunch } = window.__TAURI__.process;
  const version = await getVersion();

  let update;
  try {
    update = await check();
  } catch (err) {
    console.error("Update check failed", err);
    showAlert({
      title: "Updates",
      message: `You're on version ${version}. Couldn't check for updates right now — check your connection and try again.`,
    });
    return;
  }

  if (!update) {
    showAlert({
      title: "Updates",
      message: `You're on version ${version}. That's the latest version.`,
    });
    return;
  }

  const shouldInstall = await showConfirm({
    title: "Update available",
    message: `Version ${update.version} is available (you're on ${version}). Download and install now? The app will restart.`,
    confirmLabel: "Update and restart",
  });
  if (!shouldInstall) return;

  await update.downloadAndInstall();
  await relaunch();
}

let pendingUpdate = null;

async function checkForUpdateBadge() {
  const { check } = window.__TAURI__.updater;
  const bellDot = document.getElementById("bell-dot");
  try {
    pendingUpdate = await check();
    bellDot.hidden = !pendingUpdate;
  } catch (err) {
    // Silent background check; the bell just stays un-badged on failure.
    console.error("Background update check failed", err);
  }
}

function renderNotifPopoverBody() {
  const body = document.getElementById("notif-popover-body");
  body.innerHTML = "";

  if (!pendingUpdate) {
    const empty = document.createElement("div");
    empty.className = "notif-empty";
    empty.textContent = "No new notifications";
    body.appendChild(empty);
    return;
  }

  const item = document.createElement("div");
  item.className = "notif-item";

  const title = document.createElement("div");
  title.className = "notif-item-title";
  title.textContent = "Update available";

  const desc = document.createElement("div");
  desc.className = "notif-item-body";
  desc.textContent = `Version ${pendingUpdate.version} is ready to install.`;

  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "btn btn-teal notif-item-action";
  installBtn.textContent = "Download and install";
  installBtn.addEventListener("click", async () => {
    document.getElementById("notif-popover").hidden = true;
    await pendingUpdate.downloadAndInstall();
    await window.__TAURI__.process.relaunch();
  });

  item.appendChild(title);
  item.appendChild(desc);
  item.appendChild(installBtn);
  body.appendChild(item);
}

function toggleNotifPopover() {
  const popover = document.getElementById("notif-popover");
  const bellBtn = document.getElementById("bell-btn");

  if (!popover.hidden) {
    popover.hidden = true;
    return;
  }

  renderNotifPopoverBody();

  const rect = bellBtn.getBoundingClientRect();
  popover.style.right = `${window.innerWidth - rect.right}px`;
  popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  popover.hidden = false;

  document.addEventListener(
    "click",
    (event) => {
      if (!popover.contains(event.target) && event.target !== bellBtn && !bellBtn.contains(event.target)) {
        popover.hidden = true;
      }
    },
    { once: true, capture: true },
  );
}

function initUpdateBell() {
  const bellBtn = document.getElementById("bell-btn");

  bellBtn.addEventListener("click", () => {
    toggleNotifPopover();
    document.getElementById("bell-dot").hidden = true;
  });

  checkForUpdateBadge();
}

async function getAboutFields() {
  const { getVersion, getTauriVersion } = window.__TAURI__.app;
  const { invoke } = window.__TAURI__.core;
  const [version, tauriVersion, commitSha] = await Promise.all([
    getVersion(),
    getTauriVersion(),
    invoke("get_commit_sha"),
  ]);
  return {
    Version: version,
    Commit: commitSha,
    Tauri: tauriVersion,
    Platform: navigator.platform || "Unknown",
  };
}

async function openAboutModal() {
  const listEl = document.getElementById("about-list");
  const fields = await getAboutFields();

  listEl.innerHTML = "";
  for (const [label, value] of Object.entries(fields)) {
    const row = document.createElement("div");
    row.className = "about-row";

    const dt = document.createElement("dt");
    dt.textContent = label;

    const dd = document.createElement("dd");
    dd.textContent = value;

    row.appendChild(dt);
    row.appendChild(dd);
    listEl.appendChild(row);
  }

  document.getElementById("about-overlay").hidden = false;
}

function initAboutModal() {
  const overlay = document.getElementById("about-overlay");
  const closeBtn = document.getElementById("about-close");
  const copyBtn = document.getElementById("about-copy");

  closeBtn.addEventListener("click", () => {
    overlay.hidden = true;
  });
  copyBtn.addEventListener("click", async () => {
    const fields = await getAboutFields();
    const text = Object.entries(fields)
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy about info", err);
    }
  });
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) overlay.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) overlay.hidden = true;
  });
}

let activeMenuButton = null;

function openMenu(button, items) {
  if (isContextMenuVisible() && activeMenuButton === button) {
    hideContextMenu();
    activeMenuButton = null;
    return;
  }
  const rect = button.getBoundingClientRect();
  showContextMenu(rect.left, rect.bottom + 4, items, { trigger: button });
  activeMenuButton = button;
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
      { label: "Recover orphaned videos", onClick: recoverVideos },
      { label: "Reset all data", danger: true, onClick: resetAllData },
    ]);
  });

  viewBtn.addEventListener("click", async () => {
    const settings = await getRecordingSettings();
    const theme = await getTheme();
    openMenu(viewBtn, [
      {
        label: "Always on top",
        checked: Boolean(settings.alwaysOnTop),
        onClick: async () => {
          const current = await getRecordingSettings();
          const next = !current.alwaysOnTop;
          await appWindow.setAlwaysOnTop(next);
          await saveRecordingSettings({ alwaysOnTop: next });
        },
      },
      {
        label: "Dark mode",
        checked: theme === "dark",
        onClick: async () => {
          const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
          const next = current === "light" ? "dark" : "light";
          applyTheme(next);
          await setTheme(next);
        },
      },
      {
        label: "Show sidebar",
        checked: isRailVisible(),
        onClick: () => setRailVisible(!isRailVisible()),
      },
      {
        label: "Reset view",
        onClick: resetView,
      },
    ]);
  });

  helpBtn.addEventListener("click", () => {
    openMenu(helpBtn, [
      { label: "Check for updates", onClick: showUpdatesInfo },
      {
        label: "Report an issue",
        onClick: () => window.__TAURI__.opener.openUrl("https://github.com/ei-sei/flight-recorder/issues"),
      },
      { label: "About", onClick: openAboutModal },
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
  initAboutModal();
  initUpdateBell();
  initSidebar();
  initLogPanelToggle();
  initPanelResize();
  initRail();

  const settings = await getRecordingSettings();
  if (settings.alwaysOnTop) {
    await appWindow.setAlwaysOnTop(true);
  }

  applyTheme(await getTheme());

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
    onOpenSettings: openSettingsModal,
  });
}

init();
