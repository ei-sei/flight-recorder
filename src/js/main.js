import {
  initQuestions,
  getSelectedQuestion,
  selectQuestionById,
  updateQuestionPrepNotes,
  getQuestionCount,
} from "./questions.js";
import {
  initRecorder,
  setActiveQuestion,
  enterReviewMode,
  exitReviewMode,
  renderReviewDetails,
  listDevices,
  applyRecordingSettings,
  applyMicGain,
} from "./recorder.js";
import {
  initAttempts,
  saveAttempt,
  clearReviewing,
  setSelectedQuestion,
  updateAttemptNotes,
  updateAttemptScore,
  getAttemptCount,
} from "./attempts.js";
import {
  getRecordingSettings,
  saveRecordingSettings,
  clearAllData,
  getTheme,
  setTheme,
  libraryDir,
} from "./store.js";
import { formatBytes, pluralise } from "./util.js";
import { showAlert, showConfirm } from "./modal.js";
import { showContextMenu, hideContextMenu, isContextMenuVisible } from "./contextmenu.js";
import {
  mkdir,
  exists,
  remove,
  openPath,
  openUrl,
  getLibrarySize,
  getVersion,
  getBuildInfo,
  checkForUpdate,
  relaunch,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  setAlwaysOnTop,
  setWindowSize,
  openDevtools,
} from "./platform.js";

const clockEl = document.getElementById("clock");
const currentQuestionEl = document.getElementById("current-question");

// localStorage throws rather than returning null in some webview
// configurations, so every access has to be guarded. Guarded once here
// instead of in six near-identical try/catch pairs. This holds view state
// only - window layout and theme - never anything about a recording, which
// lives in library.json (store.js).
function readLocal(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (err) {
    // Unavailable; this setting just won't persist across launches.
  }
}

function removeLocal(key) {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    // Unavailable; nothing to clear.
  }
}

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  // library.json (store.js) remains the source of truth; this is only so
  // theme-boot.js can set the theme before the modules load.
  writeLocal("theme", theme);
}

function isSidebarVisible() {
  return readLocal("sidebarVisible", "true") !== "false";
}

function setSidebarVisible(visible) {
  document.querySelector(".layout").classList.toggle("sidebar-hidden", !visible);
  document.getElementById("rail-questions").classList.toggle("active", visible);
  writeLocal("sidebarVisible", visible);
}

function initSidebar() {
  setSidebarVisible(isSidebarVisible());

  document.getElementById("rail-questions").addEventListener("click", () => {
    setSidebarVisible(!isSidebarVisible());
  });
}

function isLogPanelVisible() {
  return readLocal("logPanelVisible", "true") !== "false";
}

function setLogPanelVisible(visible) {
  document.querySelector(".layout").classList.toggle("log-hidden", !visible);
  document.getElementById("rail-log").classList.toggle("active", visible);
  writeLocal("logPanelVisible", visible);
}

function initLogPanelToggle() {
  setLogPanelVisible(isLogPanelVisible());

  document.getElementById("rail-log").addEventListener("click", () => {
    setLogPanelVisible(!isLogPanelVisible());
  });
}

// Must match the --sidebar-w / --log-w defaults in style.css. These are what
// "Reset view" restores to, so a mismatch means Reset view moves the panels
// somewhere the app has never actually started up in.
const SIDEBAR_DEFAULT = 257;
const LOG_DEFAULT = 332;

// Assigned by initPanelResize, which closes over the live width state. Declared
// here rather than below its own assignment, where it used to sit.
let resetPanelWidths = () => {};

function initPanelResize() {
  const layoutEl = document.querySelector(".layout");
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 500;
  const LOG_MIN = 260;
  const LOG_MAX = 600;

  function getStoredWidth(key, fallback) {
    const value = parseInt(readLocal(key, ""), 10);
    return Number.isFinite(value) ? value : fallback;
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
      writeLocal("sidebarWidthPx", sidebarWidth);
      writeLocal("logWidthPx", logWidth);
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
    removeLocal("sidebarWidthPx");
    removeLocal("logWidthPx");
  };
}

async function resetView() {
  resetPanelWidths();
  // Both content panels visible, activity rail hidden. This used to be the
  // other way round - question panel collapsed, rail shown to bring it back -
  // which put the app in a state it never actually starts in: the rail
  // defaults to hidden on a fresh install (see isRailVisible). Reset view
  // should return to the default, not to a different arrangement of its own.
  setSidebarVisible(true);
  setLogPanelVisible(true);
  setRailVisible(false);

  try {
    // Must match the window's default size (DEFAULT_WIDTH/HEIGHT in
    // electron/window-state.js).
    await setWindowSize(1280, 800);
  } catch (err) {
    console.error("Reset window size failed", err);
    await showAlert({ title: "Couldn't resize window", message: String(err?.message ?? err) });
  }
}

function isRailVisible() {
  return readLocal("railVisible", "false") === "true";
}

function setRailVisible(visible) {
  document.getElementById("activity-rail").hidden = !visible;
  writeLocal("railVisible", visible);
}

function initRail() {
  setRailVisible(isRailVisible());
}

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}

// `filterAttemptLog` distinguishes the user picking a question from a question
// being selected on their behalf. Picking one in the sidebar should narrow the
// attempt log to it; having one selected as a side effect of clicking a video
// in that same log should leave the log alone, or the list reorganises itself
// under the cursor that just clicked it.
function handleQuestionSelectionChange(question, { filterAttemptLog = true } = {}) {
  // No-ops if not currently reviewing (including the reverse path, where
  // onPlay selects the attempt's question before entering review mode -
  // isReviewing is still false at that point). Picking a different question
  // from the sidebar while reviewing an attempt should return to the live
  // camera view instead of leaving the reviewed video showing.
  exitReviewMode();
  currentQuestionEl.textContent = question ? question.text : "Select a question to begin.";
  setActiveQuestion(question);
  if (filterAttemptLog) setSelectedQuestion(question);
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
  try {
    const dir = await libraryDir();
    await mkdir(dir, { recursive: true });
    await openPath(dir);
  } catch (err) {
    console.error("Open recordings folder failed", err);
    await showAlert({ title: "Couldn't open folder", message: String(err?.message ?? err) });
  }
}

// Spells out exactly what is about to go, rather than saying "every question,
// every attempt, and every recorded video" - which is true of an empty library
// too, and is easy to skim past. Knowing it is 11 attempts and 118 MB is the
// difference between reading the dialog and dismissing it.
async function buildResetWarning() {
  const questionCount = getQuestionCount();
  const attemptCount = getAttemptCount();

  if (questionCount === 0 && attemptCount === 0) {
    return "There are no questions or attempts to delete, but this will still reset the folder and every setting. This can't be undone.";
  }

  let size = "";
  try {
    // Awaited rather than filled in afterwards: the number is the point, and a
    // dialog that asks you to type DELETE should be complete before you read
    // it. Measured off the UI thread, so this doesn't block the UI.
    const bytes = await getLibrarySize();
    if (bytes > 0) size = `, including ${formatBytes(bytes)} of recorded video`;
  } catch (err) {
    // Worth continuing without: the counts alone still say enough, and a
    // failure to measure shouldn't stand between the user and a reset.
    console.error("Couldn't measure the library folder for the reset warning", err);
  }

  return (
    `This deletes ${pluralise(questionCount, "question")} and ` +
    `${pluralise(attemptCount, "attempt")}${size}. This can't be undone.`
  );
}

async function resetAllData() {
  const confirmed = await showConfirm({
    title: "Reset all data?",
    message: await buildResetWarning(),
    confirmLabel: "Reset everything",
    danger: true,
    requireTypedWord: "DELETE",
  });
  if (!confirmed) return;

  try {
    const dir = await libraryDir();
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

// Deliberately not awaited by the caller - walking the folder takes a moment
// once there are a few hundred recordings in it, and the rest of the dialog
// shouldn't wait on a number that's only informational.
async function refreshLibrarySize() {
  const el = document.getElementById("settings-library-size");
  el.textContent = "Calculating…";
  try {
    const bytes = await getLibrarySize();
    // Size and location only. "Nothing is deleted automatically" is static
    // markup in the status block now, rather than being rebuilt into this
    // string every time the folder is measured.
    el.textContent = `${formatBytes(bytes)} · Videos/flight-recorder`;
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

  const settings = await getRecordingSettings();
  const { cameras, mics } = await listDevices();

  refreshLibrarySize();

  populateDeviceSelect(cameraSelect, cameras, settings.cameraId, "Camera");
  populateDeviceSelect(micSelect, mics, settings.micId, "Microphone");
  qualitySelect.value = settings.quality;
  document.getElementById("settings-mic-gain").value = String(settings.micGainDb);

  overlay.hidden = false;
}

// The three ways every overlay in this app closes: its own close button, a
// click on the backdrop but not the box, and Escape. Settings and About each
// spelled this out separately, and modal.js has its own variant because it has
// to resolve a promise as well.
function wireOverlayDismiss(overlay, closeBtn) {
  const close = () => {
    overlay.hidden = true;
  };
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) close();
  });
}

function initSettingsModal() {
  const cameraSelect = document.getElementById("settings-camera");
  const micSelect = document.getElementById("settings-mic");
  const qualitySelect = document.getElementById("settings-quality");

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

  // Its own handler rather than applyDeviceChange: gain is a value on a node
  // in the existing audio graph, so it takes effect without re-acquiring the
  // camera. Routing it through applyRecordingSettings would blink the preview
  // every time the number changed.
  document.getElementById("settings-mic-gain").addEventListener("change", (event) => {
    applyMicGain(Number(event.target.value));
  });

  wireOverlayDismiss(
    document.getElementById("settings-overlay"),
    document.getElementById("settings-close"),
  );
}

async function showUpdatesInfo() {
  const version = await getVersion();

  let update;
  try {
    update = await checkForUpdate();
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

  await installUpdate(update);
}

// Both entry points to installing an update - the Help menu and the bell
// popover - want the same thing: install, restart, and say so if it fails.
async function installUpdate(update) {
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
  const bellDot = document.getElementById("bell-dot");
  try {
    pendingUpdate = await checkForUpdate();
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
    await installUpdate(pendingUpdate);
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
  const [version, buildInfo] = await Promise.all([getVersion(), getBuildInfo()]);
  return {
    Version: version,
    // Commit, plus which shell and engine versions this build is made of.
    ...buildInfo,
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
  const copyBtn = document.getElementById("about-copy");

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

  wireOverlayDismiss(
    document.getElementById("about-overlay"),
    document.getElementById("about-close"),
  );
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
          await setAlwaysOnTop(next);
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
        // "Show sidebar" until now, which named the wrong thing: this toggles
        // the icon strip, while the sidebar proper is the question panel that
        // strip opens and closes.
        label: "Show activity bar",
        checked: isRailVisible(),
        onClick: () => setRailVisible(!isRailVisible()),
      },
      {
        label: "Reset view",
        onClick: resetView,
      },
      // Here rather than only on a right-click of the title bar: that bar is
      // the window's drag handle, and a drag region can't have a menu of its
      // own.
      { label: "Reload", onClick: () => window.location.reload() },
      { label: "Developer tools", onClick: openDevtools },
    ]);
  });

  helpBtn.addEventListener("click", () => {
    openMenu(helpBtn, [
      { label: "Check for updates", onClick: showUpdatesInfo },
      {
        label: "Report an issue",
        onClick: () => openUrl("https://github.com/ei-sei/flight-recorder/issues"),
      },
      { label: "About", onClick: openAboutModal },
    ]);
  });
}

function initWindowControls() {
  document.getElementById("win-minimize").addEventListener("click", () => minimizeWindow());
  document.getElementById("win-maximize").addEventListener("click", () => toggleMaximizeWindow());
  document.getElementById("win-close").addEventListener("click", () => closeWindow());
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
    // activity rail (the icon strip that toggles the side panels) only.
    // Everywhere else just gets the native menu suppressed. The title bar
    // used to offer this too, but it's the window's drag handle, which can't
    // have a menu of its own - View > Reload / Developer tools cover it.
    if (!event.target.closest(".activity-rail")) return;

    showContextMenu(event.clientX, event.clientY, [
      { label: "Refresh", onClick: () => window.location.reload() },
      { label: "Inspect", onClick: openDevtools },
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
    await setAlwaysOnTop(true);
  }

  applyTheme(theme);

  await initAttempts({
    onPlay: (attempt, attemptNumber) => {
      // Selects the question in the sidebar so the record button and prep
      // notes follow the video being reviewed, but deliberately leaves the
      // attempt log's own filter and tab alone - the user clicked a row in
      // that list and it should still be the list they clicked.
      selectQuestionById(attempt.questionId, { filterAttemptLog: false });
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
      // Also leaves the log filter alone. Narrowing it on the way out of
      // review would just delay the same surprise: the list would sit
      // untouched while a video played, then reorganise the moment it closed.
      handleQuestionSelectionChange(getSelectedQuestion(), { filterAttemptLog: false });
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
