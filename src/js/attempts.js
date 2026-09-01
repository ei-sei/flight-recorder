const { videoDir, join } = window.__TAURI__.path;
const { mkdir, writeFile, readFile, readDir, exists, remove } = window.__TAURI__.fs;
const { revealItemInDir } = window.__TAURI__.opener;

// The only three category values the app ever creates a folder for (see
// questions.js's fixed tab list) - safe to hardcode as a reverse lookup
// from the slug back to its real display name.
const CATEGORY_BY_SLUG = { behavioral: "Behavioral", technical: "Technical", case: "Case" };

import { getAttempts, saveAttempts } from "./store.js";
import { slugify, shortDateStamp, abbreviateQuestion, formatDuration, renderStars } from "./util.js";
import { showConfirm } from "./modal.js";
import { showContextMenu } from "./contextmenu.js";

let attempts = [];
let activeFilter = "All";
let selectedQuestion = null;
let reviewingId = null;
let onPlay = () => {};
let onExitReview = () => {};
const listEl = document.getElementById("attempt-list");
const subtitleEl = document.getElementById("log-subtitle");
const filterTabsEl = document.getElementById("log-filter-tabs");

async function computeVideoPath(question, date, extension) {
  const base = await videoDir();
  const categorySlug = slugify(question.category);
  const dirPath = await join(base, "flight-recorder", categorySlug);
  await mkdir(dirPath, { recursive: true });

  const stamp = shortDateStamp(date);
  const abbreviation = abbreviateQuestion(question.text);
  const attemptNumber = attempts.filter((a) => a.questionId === question.id).length + 1;

  let filename = `${stamp}-a${attemptNumber}-${abbreviation}.${extension}`;
  let candidate = await join(dirPath, filename);
  let counter = 2;
  while (await exists(candidate)) {
    filename = `${stamp}-a${attemptNumber}-${abbreviation}-${counter}.${extension}`;
    candidate = await join(dirPath, filename);
    counter += 1;
  }
  return candidate;
}

// Handles both filename conventions this app has ever written: the current
// short one (260901-a2-abbrev.ext) and the older, fully-slugified-question
// one (2026-09-01_some-long-question.ext) - so recovery works on videos
// saved before this format changed too.
function inferDateFromFilename(filename) {
  let match = filename.match(/^(\d{2})(\d{2})(\d{2})-a\d+-/);
  if (match) {
    const [, yy, mm, dd] = match;
    return new Date(2000 + Number(yy), Number(mm) - 1, Number(dd));
  }
  match = filename.match(/^(\d{4})-(\d{2})-(\d{2})[_-]/);
  if (match) {
    const [, yyyy, mm, dd] = match;
    return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  }
  return new Date();
}

async function probeDurationMs(path) {
  try {
    const bytes = await readFile(path);
    const mimeType = path.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/webm";
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const durationSeconds = await new Promise((resolve) => {
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => resolve(probe.duration);
      probe.onerror = () => resolve(0);
      probe.src = url;
    });
    URL.revokeObjectURL(url);
    return Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : 0;
  } catch (err) {
    console.error("Failed to probe recovered video duration", err);
    return 0;
  }
}

async function findOrphanedVideos() {
  const base = await videoDir();
  const rootDir = await join(base, "flight-recorder");
  if (!(await exists(rootDir))) return [];

  const knownPaths = new Set(attempts.map((a) => a.videoPath));
  const orphans = [];

  for (const categoryEntry of await readDir(rootDir)) {
    if (!categoryEntry.isDirectory) continue;
    const categoryPath = await join(rootDir, categoryEntry.name);

    for (const fileEntry of await readDir(categoryPath)) {
      if (!fileEntry.isFile || !/\.(webm|mp4)$/i.test(fileEntry.name)) continue;
      const filePath = await join(categoryPath, fileEntry.name);
      if (knownPaths.has(filePath)) continue;
      orphans.push({ path: filePath, filename: fileEntry.name, categorySlug: categoryEntry.name });
    }
  }

  return orphans;
}

// Rebuilds bare attempt entries for video files on disk that the store has
// no record of (e.g. after an uninstall that wiped app data but left the
// user's actual video files alone). The original question text can't be
// recovered - it was never stored anywhere but the wiped JSON - so these
// come back unlinked from any question, with the category inferred from
// the folder and the date from the filename.
export async function recoverOrphanedVideos() {
  const orphans = await findOrphanedVideos();
  if (orphans.length === 0) return 0;

  for (const orphan of orphans) {
    attempts.unshift({
      id: crypto.randomUUID(),
      questionId: null,
      questionText: "(Recovered video - original question unknown)",
      category: CATEGORY_BY_SLUG[orphan.categorySlug] ?? orphan.categorySlug,
      date: inferDateFromFilename(orphan.filename).toISOString(),
      durationMs: await probeDurationMs(orphan.path),
      videoPath: orphan.path,
      score: 0,
      notes: "",
      responseDelayMs: null,
      wpm: null,
      transcript: null,
    });
  }

  await saveAttempts(attempts);
  render();
  return orphans.length;
}

export async function saveAttempt({ blob, extension, durationMs, question, responseDelayMs, wpm, transcript }) {
  const date = new Date();
  const videoPath = await computeVideoPath(question, date, extension || "webm");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(videoPath, bytes);

  const attempt = {
    id: crypto.randomUUID(),
    questionId: question.id,
    questionText: question.text,
    category: question.category,
    date: date.toISOString(),
    durationMs,
    videoPath,
    score: 0,
    notes: "",
    responseDelayMs: responseDelayMs ?? null,
    wpm: wpm ?? null,
    transcript: transcript ?? null,
  };

  attempts.unshift(attempt);
  await saveAttempts(attempts);
  render();
  return attempt;
}

async function updateAttempt(id, patch) {
  const attempt = attempts.find((a) => a.id === id);
  if (!attempt) return;
  Object.assign(attempt, patch);
  await saveAttempts(attempts);
  render();
}

export async function updateAttemptNotes(id, notes) {
  await updateAttempt(id, { notes });
}

export async function updateAttemptScore(id, score) {
  await updateAttempt(id, { score });
}

async function deleteAttempt(id) {
  const attempt = attempts.find((a) => a.id === id);
  if (!attempt) return;

  const confirmed = await showConfirm({
    title: "Delete attempt?",
    message: "This will delete the attempt and its video file. This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;

  if (reviewingId === id) {
    onExitReview();
    reviewingId = null;
  }

  try {
    await remove(attempt.videoPath);
  } catch (err) {
    console.error("Failed to remove video file", err);
  }

  attempts = attempts.filter((a) => a.id !== id);
  await saveAttempts(attempts);
  render();
}

export async function deleteAttemptsForQuestion(questionId) {
  const toDelete = attempts.filter((a) => a.questionId === questionId);
  if (toDelete.length === 0) return;

  if (toDelete.some((a) => a.id === reviewingId)) {
    onExitReview();
    reviewingId = null;
  }

  for (const attempt of toDelete) {
    try {
      await remove(attempt.videoPath);
    } catch (err) {
      console.error("Failed to remove video file", err);
    }
  }

  attempts = attempts.filter((a) => a.questionId !== questionId);
  await saveAttempts(attempts);
  render();
}

function formatResponseDelay(ms) {
  if (ms === null || ms === undefined) return null;
  return `delay ${(ms / 1000).toFixed(1)}s`;
}

// Computed once per render instead of re-filtering/re-sorting the whole
// attempts array per row (which renderAttemptItem needs twice per row) -
// that pattern was effectively quadratic in the attempt count.
function computeAttemptNumbers() {
  const byQuestion = new Map();
  for (const a of attempts) {
    if (!byQuestion.has(a.questionId)) byQuestion.set(a.questionId, []);
    byQuestion.get(a.questionId).push(a);
  }

  const numbers = new Map();
  for (const group of byQuestion.values()) {
    group.sort((a, b) => new Date(a.date) - new Date(b.date));
    group.forEach((a, i) => numbers.set(a.id, i + 1));
  }
  return numbers;
}

function renderAttemptItem(attempt, attemptNumber) {
  const item = document.createElement("li");
  item.className = "attempt-item" + (attempt.id === reviewingId ? " reviewing" : "");
  item.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    reviewingId = attempt.id;
    render();
    onPlay(attempt, attemptNumber);
  });
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      { label: "Show in folder", onClick: () => revealItemInDir(attempt.videoPath) },
      { label: "Delete", danger: true, onClick: () => deleteAttempt(attempt.id) },
    ]);
  });

  const body = document.createElement("div");
  body.className = "attempt-item-body";

  const top = document.createElement("div");
  top.className = "attempt-item-top";

  const topInfo = document.createElement("div");
  topInfo.className = "attempt-item-meta";

  const dateLabel = new Date(attempt.date).toLocaleDateString();
  const delayLabel = formatResponseDelay(attempt.responseDelayMs);

  const metaRow = document.createElement("div");
  metaRow.className = "attempt-item-meta-row";

  const metaLine = document.createElement("span");
  metaLine.className = "mono";
  metaLine.textContent = [`${dateLabel} · ${formatDuration(attempt.durationMs)}`, delayLabel]
    .filter(Boolean)
    .join(" · ");

  const stars = document.createElement("div");
  stars.className = "stars";
  renderStars(stars, attempt.score, null, true);

  metaRow.appendChild(metaLine);
  metaRow.appendChild(stars);

  const attemptLine = document.createElement("span");
  attemptLine.className = "mono attempt-item-number";
  attemptLine.textContent = `Attempt ${attemptNumber}`;

  topInfo.appendChild(metaRow);
  topInfo.appendChild(attemptLine);

  top.appendChild(topInfo);

  const question = document.createElement("div");
  question.className = "attempt-item-question";
  question.textContent = attempt.questionText;

  const notes = document.createElement("textarea");
  notes.className = "notes-input attempt-item-notes";
  notes.placeholder = "No notes yet.";
  notes.value = attempt.notes;
  notes.readOnly = true;
  notes.tabIndex = -1;

  body.appendChild(top);
  body.appendChild(question);
  body.appendChild(notes);

  item.appendChild(body);
  return item;
}

function render() {
  listEl.innerHTML = "";

  const filtered = attempts.filter((a) => {
    const matchesCategory = activeFilter === "All" || a.category === activeFilter;
    const matchesQuestion = !selectedQuestion || a.questionId === selectedQuestion.id;
    return matchesCategory && matchesQuestion;
  });

  if (selectedQuestion) {
    subtitleEl.textContent = `Showing attempts for “${selectedQuestion.text}”`;
  } else if (activeFilter !== "All") {
    subtitleEl.textContent = `Showing ${activeFilter} attempts`;
  } else {
    subtitleEl.textContent = "Showing all attempts";
  }

  if (filtered.length === 0) {
    const empty = document.createElement("li");
    empty.className = "attempt-list-empty";
    empty.textContent = selectedQuestion ? "No attempts for this question yet." : "No attempts yet.";
    listEl.appendChild(empty);
    return;
  }

  const attemptNumbers = computeAttemptNumbers();
  for (const attempt of filtered) {
    listEl.appendChild(renderAttemptItem(attempt, attemptNumbers.get(attempt.id)));
  }
}

function setActiveFilter(filter) {
  activeFilter = filter;
  selectedQuestion = null;
  for (const tab of filterTabsEl.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.filter === filter);
  }
  render();
}

export function setSelectedQuestion(question) {
  selectedQuestion = question;
  activeFilter = "All";
  for (const tab of filterTabsEl.querySelectorAll(".tab")) {
    const highlightAs = question ? question.category : activeFilter;
    tab.classList.toggle("active", tab.dataset.filter === highlightAs);
  }
  render();
}

export function getAttemptCountForQuestion(questionId) {
  return attempts.filter((a) => a.questionId === questionId).length;
}

export function clearReviewing() {
  reviewingId = null;
  render();
}

export async function initAttempts(options = {}) {
  onPlay = options.onPlay ?? (() => {});
  onExitReview = options.onExitReview ?? (() => {});
  attempts = await getAttempts();

  filterTabsEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".tab");
    if (!btn) return;
    setActiveFilter(btn.dataset.filter);
  });

  render();
}
