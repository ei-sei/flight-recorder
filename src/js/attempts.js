const { videoDir, join } = window.__TAURI__.path;
const { mkdir, writeFile, exists, remove } = window.__TAURI__.fs;
const { revealItemInDir } = window.__TAURI__.opener;
const { confirm } = window.__TAURI__.dialog;

import { getAttempts, saveAttempts } from "./store.js";
import { slugify, dateStamp, formatDuration, renderStars } from "./util.js";

let attempts = [];
let activeFilter = "All";
const listEl = document.getElementById("attempt-list");
const filterTabsEl = document.getElementById("log-filter-tabs");

async function computeVideoPath(question, date) {
  const base = await videoDir();
  const categorySlug = slugify(question.category);
  const dirPath = await join(base, "flight-recorder", categorySlug);
  await mkdir(dirPath, { recursive: true });

  const stamp = dateStamp(date);
  const questionSlug = slugify(question.text);

  let filename = `${stamp}_${questionSlug}.webm`;
  let candidate = await join(dirPath, filename);
  let counter = 2;
  while (await exists(candidate)) {
    filename = `${stamp}_${questionSlug}-${counter}.webm`;
    candidate = await join(dirPath, filename);
    counter += 1;
  }
  return candidate;
}

export async function saveAttempt({ blob, durationMs, question, responseDelayMs, wpm, transcript }) {
  const date = new Date();
  const videoPath = await computeVideoPath(question, date);
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
}

async function deleteAttempt(id) {
  const attempt = attempts.find((a) => a.id === id);
  if (!attempt) return;

  const confirmed = await confirm(
    "Delete this attempt and its video file? This can't be undone.",
    { title: "Delete attempt", kind: "warning" },
  );
  if (!confirmed) return;

  try {
    await remove(attempt.videoPath);
  } catch (err) {
    console.error("Failed to remove video file", err);
  }

  attempts = attempts.filter((a) => a.id !== id);
  await saveAttempts(attempts);
  render();
}

function formatResponseDelay(ms) {
  if (ms === null || ms === undefined) return null;
  return `delay ${(ms / 1000).toFixed(1)}s`;
}

function renderAttemptItem(attempt) {
  const item = document.createElement("li");
  item.className = "attempt-item";

  const top = document.createElement("div");
  top.className = "attempt-item-top mono";
  const dateLabel = new Date(attempt.date).toLocaleDateString();
  const delayLabel = formatResponseDelay(attempt.responseDelayMs);
  const wpmLabel = attempt.wpm ? `${Math.round(attempt.wpm)} wpm` : null;
  top.textContent = [
    `${dateLabel} · ${attempt.category} · ${formatDuration(attempt.durationMs)}`,
    delayLabel,
    wpmLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  const question = document.createElement("div");
  question.className = "attempt-item-question";
  question.textContent = attempt.questionText;

  const meta = document.createElement("div");
  meta.className = "attempt-item-meta";

  const stars = document.createElement("div");
  stars.className = "stars";
  renderStars(stars, attempt.score, (score) => updateAttempt(attempt.id, { score }));

  const revealBtn = document.createElement("button");
  revealBtn.type = "button";
  revealBtn.className = "icon-btn";
  revealBtn.textContent = "Show in folder";
  revealBtn.addEventListener("click", () => revealItemInDir(attempt.videoPath));

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "icon-btn danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => deleteAttempt(attempt.id));

  meta.appendChild(stars);
  meta.appendChild(revealBtn);
  meta.appendChild(deleteBtn);

  const notes = document.createElement("textarea");
  notes.className = "notes-input";
  notes.placeholder = "Notes…";
  notes.value = attempt.notes;
  notes.addEventListener("blur", () => updateAttempt(attempt.id, { notes: notes.value }));

  item.appendChild(top);
  item.appendChild(question);
  item.appendChild(meta);
  item.appendChild(notes);
  return item;
}

function render() {
  listEl.innerHTML = "";

  const filtered =
    activeFilter === "All" ? attempts : attempts.filter((a) => a.category === activeFilter);

  if (filtered.length === 0) {
    const empty = document.createElement("li");
    empty.className = "attempt-list-empty";
    empty.textContent = "No attempts yet.";
    listEl.appendChild(empty);
    return;
  }

  for (const attempt of filtered) {
    listEl.appendChild(renderAttemptItem(attempt));
  }
}

function setActiveFilter(filter) {
  activeFilter = filter;
  for (const tab of filterTabsEl.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.filter === filter);
  }
  render();
}

export async function initAttempts() {
  attempts = await getAttempts();

  filterTabsEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".tab");
    if (!btn) return;
    setActiveFilter(btn.dataset.filter);
  });

  render();
}
