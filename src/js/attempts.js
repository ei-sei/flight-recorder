const { videoDir, join } = window.__TAURI__.path;
const { mkdir, writeFile, exists, remove } = window.__TAURI__.fs;
const { revealItemInDir } = window.__TAURI__.opener;
const { invoke } = window.__TAURI__.core;

import { getAttempts, saveAttempts } from "./store.js";
import { slugify, shortDateStamp, abbreviateQuestion, formatDuration, renderStars, countWords } from "./util.js";
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

// Resolves a video's path relative to the flight-recorder folder into a
// real, absolute one for the current machine - stored paths are relative
// specifically so the flight-recorder folder (videos + library.json) stays
// portable: copy it anywhere, even a different OS, and playback/delete/
// reveal-in-folder all resolve correctly against wherever THIS machine's
// Videos folder actually is, instead of a path baked in on another machine.
export async function resolveVideoPath(relativePath) {
  const base = await videoDir();
  return join(base, "flight-recorder", relativePath);
}

async function computeVideoRelativePath(question, date, extension) {
  const base = await videoDir();
  const categorySlug = slugify(question.category);
  const dirPath = await join(base, "flight-recorder", categorySlug);
  await mkdir(dirPath, { recursive: true });

  const stamp = shortDateStamp(date);
  const abbreviation = abbreviateQuestion(question.text);
  // First 8 chars of the question's real id. The abbreviation alone is just
  // initials - two different questions can produce the same one. This makes
  // the filename->question link exact, so a file can always be matched back
  // to its real question later (e.g. recovering one with no attempt record).
  const shortId = question.id.slice(0, 8);
  const attemptNumber = attempts.filter((a) => a.questionId === question.id).length + 1;

  let filename = `${stamp}-a${attemptNumber}-${abbreviation}-${shortId}.${extension}`;
  let candidate = await join(dirPath, filename);
  let counter = 2;
  while (await exists(candidate)) {
    filename = `${stamp}-a${attemptNumber}-${abbreviation}-${shortId}-${counter}.${extension}`;
    candidate = await join(dirPath, filename);
    counter += 1;
  }
  return join(categorySlug, filename);
}

export async function saveAttempt({
  blob,
  extension,
  durationMs,
  question,
  responseDelayMs,
  pauseCount,
  longestPauseMs,
  speakingRatio,
  wpm,
  transcript,
  needsWhisperTranscription,
}) {
  const date = new Date();
  const videoRelativePath = await computeVideoRelativePath(question, date, extension || "webm");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(await resolveVideoPath(videoRelativePath), bytes);

  const attempt = {
    id: crypto.randomUUID(),
    questionId: question.id,
    questionText: question.text,
    category: question.category,
    date: date.toISOString(),
    durationMs,
    videoRelativePath,
    score: 0,
    notes: "",
    responseDelayMs: responseDelayMs ?? null,
    pauseCount: pauseCount ?? null,
    longestPauseMs: longestPauseMs ?? null,
    speakingRatio: speakingRatio ?? null,
    wpm: wpm ?? null,
    transcript: transcript ?? null,
    // Transcription runs after the file is written, so there's a window of a
    // few seconds where the attempt exists with no transcript yet. Without
    // this flag review can't tell that apart from "WPM was switched off",
    // and tells you to turn on a setting that's already on.
    transcribing: Boolean(needsWhisperTranscription),
  };

  attempts.unshift(attempt);
  await saveAttempts(attempts);
  render();

  if (needsWhisperTranscription) {
    // Not awaited - the attempt is already saved and visible; wpm/transcript
    // fill in a few seconds later once local transcription finishes.
    transcribeAttemptInBackground(attempt);
  }

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

export async function updateAttemptTranscript(id, { wpm, transcript }) {
  await updateAttempt(id, { wpm, transcript, transcribing: false });
}

async function transcribeAttemptInBackground(attempt) {
  try {
    const videoPath = await resolveVideoPath(attempt.videoRelativePath);
    const transcript = await invoke("transcribe_recording", { videoPath });
    const elapsedMinutes = attempt.durationMs / 60000;
    const wpm = transcript && elapsedMinutes > 0 ? countWords(transcript) / elapsedMinutes : null;
    await updateAttemptTranscript(attempt.id, { wpm, transcript });
  } catch (err) {
    console.error("Background transcription failed", err);
    // "" (not null) is what renders as "No speech detected" on review rather
    // than "turn on Speech pace (WPM)" - which would be wrong here, since it
    // already was on.
    await updateAttemptTranscript(attempt.id, { wpm: null, transcript: "" });
  }
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
    await remove(await resolveVideoPath(attempt.videoRelativePath));
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
      await remove(await resolveVideoPath(attempt.videoRelativePath));
    } catch (err) {
      console.error("Failed to remove video file", err);
    }
  }

  attempts = attempts.filter((a) => a.questionId !== questionId);
  await saveAttempts(attempts);
  render();
}

// Attempts snapshot the question's text so deleting a question later doesn't
// orphan log entries - a rename should still update everywhere though, not
// leave old attempts showing stale wording.
export async function renameQuestionInAttempts(questionId, text) {
  let changed = false;
  for (const attempt of attempts) {
    if (attempt.questionId === questionId && attempt.questionText !== text) {
      attempt.questionText = text;
      changed = true;
    }
  }
  if (!changed) return;
  await saveAttempts(attempts);
  render();
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
    // Already reviewing this exact attempt - onPlay() reloads and restarts
    // the video unconditionally, so skip it rather than yank playback back
    // to the start every time this row gets clicked again.
    if (attempt.id === reviewingId) return;
    reviewingId = attempt.id;
    render();
    onPlay(attempt, attemptNumber);
  });
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      { label: "Show in folder", onClick: async () => revealItemInDir(await resolveVideoPath(attempt.videoRelativePath)) },
      { label: "Delete", danger: true, onClick: () => deleteAttempt(attempt.id) },
    ]);
  });

  const body = document.createElement("div");
  body.className = "attempt-item-body";

  const top = document.createElement("div");
  top.className = "attempt-item-top";

  const topInfo = document.createElement("div");
  topInfo.className = "attempt-item-meta";

  const dateLabel = new Date(attempt.date).toLocaleDateString("en-GB");

  const metaRow = document.createElement("div");
  metaRow.className = "attempt-item-meta-row";

  const metaLine = document.createElement("span");
  metaLine.className = "mono";
  metaLine.textContent = `${dateLabel} · ${formatDuration(attempt.durationMs)}`;

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
