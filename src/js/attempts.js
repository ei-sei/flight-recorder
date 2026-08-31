const { videoDir, join } = window.__TAURI__.path;
const { mkdir, writeFile, exists } = window.__TAURI__.fs;

import { getAttempts, saveAttempts } from "./store.js";
import { slugify, dateStamp, formatDuration } from "./util.js";

let attempts = [];
const listEl = document.getElementById("attempt-list");

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

export async function saveAttempt({ blob, durationMs, question }) {
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
    responseDelayMs: null,
    wpm: null,
    transcript: null,
  };

  attempts.unshift(attempt);
  await saveAttempts(attempts);
  render();
  return attempt;
}

function render() {
  listEl.innerHTML = "";

  if (attempts.length === 0) {
    const empty = document.createElement("li");
    empty.className = "attempt-list-empty";
    empty.textContent = "No attempts yet.";
    listEl.appendChild(empty);
    return;
  }

  for (const attempt of attempts) {
    const item = document.createElement("li");
    item.className = "attempt-item";

    const top = document.createElement("div");
    top.className = "attempt-item-top mono";
    const dateLabel = new Date(attempt.date).toLocaleDateString();
    top.textContent = `${dateLabel} · ${attempt.category} · ${formatDuration(attempt.durationMs)}`;

    const question = document.createElement("div");
    question.className = "attempt-item-question";
    question.textContent = attempt.questionText;

    item.appendChild(top);
    item.appendChild(question);
    listEl.appendChild(item);
  }
}

export async function initAttempts() {
  attempts = await getAttempts();
  render();
}
