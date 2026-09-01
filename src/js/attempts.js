const { videoDir, join } = window.__TAURI__.path;
const { mkdir, writeFile, exists, remove } = window.__TAURI__.fs;
const { revealItemInDir } = window.__TAURI__.opener;

import { getAttempts, saveAttempts } from "./store.js";
import { slugify, dateStamp, formatDuration, renderStars } from "./util.js";
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

  const stamp = dateStamp(date);
  const questionSlug = slugify(question.text);

  let filename = `${stamp}_${questionSlug}.${extension}`;
  let candidate = await join(dirPath, filename);
  let counter = 2;
  while (await exists(candidate)) {
    filename = `${stamp}_${questionSlug}-${counter}.${extension}`;
    candidate = await join(dirPath, filename);
    counter += 1;
  }
  return candidate;
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

function getAttemptNumber(attempt) {
  const sameQuestion = attempts
    .filter((a) => a.questionId === attempt.questionId)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  return sameQuestion.findIndex((a) => a.id === attempt.id) + 1;
}

function renderAttemptItem(attempt) {
  const item = document.createElement("li");
  item.className = "attempt-item" + (attempt.id === reviewingId ? " reviewing" : "");
  item.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    reviewingId = attempt.id;
    render();
    onPlay(attempt, getAttemptNumber(attempt));
  });
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      { label: "Show in folder", onClick: () => revealItemInDir(attempt.videoPath) },
      { label: "Delete", danger: true, onClick: () => deleteAttempt(attempt.id) },
    ]);
  });

  const avatar = document.createElement("div");
  avatar.className = "attempt-avatar";
  avatar.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';

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
  attemptLine.textContent = `Attempt ${getAttemptNumber(attempt)}`;

  topInfo.appendChild(metaRow);
  topInfo.appendChild(attemptLine);

  top.appendChild(topInfo);

  const question = document.createElement("div");
  question.className = "attempt-item-question";
  question.textContent = attempt.questionText;

  const notes = document.createElement("textarea");
  notes.className = "notes-input";
  notes.placeholder = "No notes yet.";
  notes.value = attempt.notes;
  notes.readOnly = true;
  notes.tabIndex = -1;

  body.appendChild(top);
  body.appendChild(question);
  body.appendChild(notes);

  item.appendChild(avatar);
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

  for (const attempt of filtered) {
    listEl.appendChild(renderAttemptItem(attempt));
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
