import { initQuestions, getSelectedQuestion, selectQuestionById, updateQuestionPrepNotes } from "./questions.js";
import {
  initRecorder,
  setActiveQuestion,
  enterReviewMode,
  exitReviewMode,
  renderReviewDetails,
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
import { getRecordingSettings, saveRecordingSettings, clearAllData, getTheme, setTheme } from "./store.js";
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

async function resetView() {
  resetPanelWidths();
  setSidebarVisible(true);
  setLogPanelVisible(true);
  setRailVisible(true);

  try {
    // Must match tauri.conf.json's app.windows[0] width/height default.
    // Needs core:window:allow-set-size in capabilities - core:default only
    // grants read-only window commands, so without it this rejects.
    const { LogicalSize } = window.__TAURI__.window;
    await appWindow.setSize(new LogicalSize(1280, 800));
  } catch (err) {
    console.error("Reset window size failed", err);
    await showAlert({ title: "Couldn't resize window", message: String(err?.message ?? err) });
  }
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
  setActiveQuestion(question);
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

  try {
    const dir = await join(await videoDir(), "flight-recorder");
    await mkdir(dir, { recursive: true });
    await openPath(dir);
  } catch (err) {
    console.error("Open recordings folder failed", err);
    await showAlert({ title: "Couldn't open folder", message: String(err?.message ?? err) });
  }
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

  try {
    const dir = await join(await videoDir(), "flight-recorder");
    if (await exists(dir)) {
      await remove(dir, { recursive: true });
    }
    await clearAllData();
  } catch (err) {
    console.error("Reset all data failed", err);
    await showAlert({ title: "Reset failed", message: String(err?.message ?? err) });
    return;
  }
  location.reload();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// Deliberately not awaited by the caller - walking the folder takes a moment
// once there are a few hundred recordings in it, and the rest of the dialog
// shouldn't wait on a number that's only informational.
async function refreshLibrarySize() {
  const { invoke } = window.__TAURI__.core;
  const el = document.getElementById("settings-library-size");
  el.textContent = "Calculating…";
  try {
    const bytes = await invoke("get_library_size");
    el.textContent = `${formatBytes(bytes)} in Videos/flight-recorder. Nothing is deleted automatically.`;
  } catch (err) {
    console.error("Couldn't measure the library folder", err);
    el.textContent = "Couldn't measure the library folder.";
  }
}

async function openSettingsModal() {
  const overlay = document.getElementById("settings-overlay");
  const cameraSelect = document.getElementById("settings-camera");
  const micSelect = document.getElementById("settings-mic");
  const qualitySelect = document.getElementById("settings-quality");
  const noiseSuppressionInput = document.getElementById("settings-noise-suppression");
  const autoGainInput = document.getElementById("settings-auto-gain");

  const settings = await getRecordingSettings();
  const { cameras, mics } = await listDevices();

  noiseSuppressionInput.checked = settings.noiseSuppression !== false;
  autoGainInput.checked = settings.autoGainControl !== false;
  refreshLibrarySize();

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
  const noiseSuppressionInput = document.getElementById("settings-noise-suppression");
  const autoGainInput = document.getElementById("settings-auto-gain");
  const closeBtn = document.getElementById("settings-close");

  async function applyDeviceChange() {
    await applyRecordingSettings({
      cameraId: cameraSelect.value || null,
      micId: micSelect.value || null,
      quality: qualitySelect.value,
      noiseSuppression: noiseSuppressionInput.checked,
      autoGainControl: autoGainInput.checked,
    });
  }

  cameraSelect.addEventListener("change", applyDeviceChange);
  micSelect.addEventListener("change", applyDeviceChange);
  qualitySelect.addEventListener("change", applyDeviceChange);
  // Same path as a device change - the constraint is baked into the track at
  // getUserMedia time, so the stream has to be reacquired for it to take.
  noiseSuppressionInput.addEventListener("change", applyDeviceChange);
  autoGainInput.addEventListener("change", applyDeviceChange);

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

  try {
    await update.downloadAndInstall();
  } catch (err) {
    console.error("Update install failed", err);
    await showAlert({ title: "Update failed", message: String(err?.message ?? err) });
    return;
  }
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
    try {
      await pendingUpdate.downloadAndInstall();
    } catch (err) {
      console.error("Update install failed", err);
      await showAlert({ title: "Update failed", message: String(err?.message ?? err) });
      return;
    }
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

// Read off disk rather than from the store's whisperModelDownloaded flag -
// that flag only exists to skip re-prompting and is allowed to drift, which
// is fine for a prompt and not fine for a panel claiming to state facts.
function describeSpeechModel(status) {
  if (!status) return "Unavailable";
  // "ggml-base.en-q5_1.bin" -> "base.en-q5_1"
  const name = status.name.replace(/^ggml-/, "").replace(/\.bin$/, "");
  if (!status.installed) return `${name} (not downloaded)`;
  return `${name} (${formatBytes(status.size_bytes)})`;
}

async function getAboutFields() {
  const { getVersion, getTauriVersion } = window.__TAURI__.app;
  const { invoke } = window.__TAURI__.core;
  const [version, tauriVersion, commitSha, modelStatus] = await Promise.all([
    getVersion(),
    getTauriVersion(),
    invoke("get_commit_sha"),
    // Not fatal - About should still open if this fails for any reason.
    invoke("get_whisper_model_status").catch((err) => {
      console.error("Couldn't read the speech model status", err);
      return null;
    }),
  ]);
  return {
    Version: version,
    Commit: commitSha,
    Tauri: tauriVersion,
    // The one component that's downloaded rather than shipped, and the first
    // thing to check when a transcript comes out wrong.
    "Speech model": describeSpeechModel(modelStatus),
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
  // The webview's native context menu reads as a website, not a desktop app
  // (Back, Save image as, Translate, "send tab to your devices", ...), so
  // it's suppressed everywhere. Areas with their own menu (questions,
  // attempts) preventDefault in their own listener, which runs first -
  // checking defaultPrevented is what stops this one clobbering theirs.
  document.addEventListener("contextmenu", (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();

    // Refresh/Inspect are app-chrome actions, not something that belongs
    // over the video, transcript, or anywhere content lives - scoped to the
    // topbar and the activity rail (the icon strip that toggles the side
    // panels) only. Everywhere else just gets the native menu suppressed,
    // same as before this feature existed.
    if (!event.target.closest(".topbar, .activity-rail")) return;

    showContextMenu(event.clientX, event.clientY, [
      { label: "Refresh", onClick: () => window.location.reload() },
      { label: "Inspect", onClick: () => window.__TAURI__.core.invoke("open_devtools") },
    ]);
  });

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

  // Read-only store lookups, so they can overlap. getAttempts/getQuestions
  // below are deliberately left sequential - both can write (the Behavioural
  // migration), and racing two save() calls on the same store risks one
  // snapshot clobbering the other.
  const [settings, theme] = await Promise.all([getRecordingSettings(), getTheme()]);
  if (settings.alwaysOnTop) {
    await appWindow.setAlwaysOnTop(true);
  }

  applyTheme(theme);

  await initAttempts({
    onPlay: (attempt, attemptNumber) => {
      selectQuestionById(attempt.questionId);
      enterReviewMode(attempt, attemptNumber);
    },
    onExitReview: exitReviewMode,
    // Refreshes the stats and transcript in place, without touching the
    // video element - transcription finishing shouldn't restart playback.
    onReviewingAttemptUpdated: renderReviewDetails,
  });
  await initQuestions({ onSelectionChange: handleQuestionSelectionChange });
  await initRecorder({
    getSelectedQuestion,
    cameraEnabled: settings.cameraEnabled,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    // Wrapped rather than passing saveAttempt directly: this runs from
    // MediaRecorder's onstop handler, which nothing awaits, so a failure
    // here (disk full, permissions) would otherwise reject into nowhere and
    // lose the recording without telling anyone.
    onRecordingComplete: async (recording) => {
      try {
        await saveAttempt(recording);
      } catch (err) {
        console.error("Failed to save recording", err);
        await showAlert({
          title: "Recording not saved",
          message: `The recording couldn't be written to disk and has been lost: ${String(err?.message ?? err)}`,
        });
      }
    },
    onExitReview: () => {
      handleQuestionSelectionChange(getSelectedQuestion());
      clearReviewing();
    },
    onNotesChange: updateAttemptNotes,
    onScoreChange: updateAttemptScore,
    onOpenSettings: openSettingsModal,
    onPrepNotesChange: updateQuestionPrepNotes,
  });
}

// If setup fails (e.g. can't create Videos/flight-recorder/), show it
// instead of leaving a broken, silent app with no explanation.
init().catch(async (err) => {
  console.error("App failed to start", err);
  await showAlert({ title: "Failed to start", message: String(err?.message ?? err) });
});
