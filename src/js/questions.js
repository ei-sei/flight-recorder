import { getQuestions, saveQuestions } from "./store.js";
import { getAttemptCountForQuestion, deleteAttemptsForQuestion } from "./attempts.js";
import { showConfirm } from "./modal.js";
import { showContextMenu } from "./contextmenu.js";

let questions = [];
let activeCategory = "Behavioural";
let selectedId = null;
let onSelectionChange = () => {};

const listEl = document.getElementById("question-list");
const tabsEl = document.getElementById("question-category-tabs");
const formEl = document.getElementById("add-question-form");
const inputEl = document.getElementById("new-question-input");

function render() {
  const filtered = questions.filter((q) => q.category === activeCategory);
  listEl.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("li");
    empty.className = "question-list-empty";
    empty.textContent = "No questions yet in this category.";
    listEl.appendChild(empty);
    return;
  }

  for (const q of filtered) {
    const item = document.createElement("li");
    item.className = "question-item" + (q.id === selectedId ? " selected" : "");
    item.dataset.id = q.id;

    const text = document.createElement("span");
    text.className = "question-item-text";
    text.textContent = q.text;

    item.appendChild(text);
    item.addEventListener("click", () => selectQuestion(q.id));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        { label: "Delete question", danger: true, onClick: () => confirmDeleteQuestion(q) },
      ]);
    });
    listEl.appendChild(item);
  }
}

async function confirmDeleteQuestion(question) {
  const count = getAttemptCountForQuestion(question.id);
  const videoNote =
    count > 0
      ? `You have recorded ${count} video${count === 1 ? "" : "s"} under this question. Deleting it will also delete ${count === 1 ? "that video" : "those videos"}. This can't be undone.`
      : "This question has no recorded attempts.";

  const confirmed = await showConfirm({
    title: "Delete question?",
    message: videoNote,
    confirmLabel: "Delete",
    danger: true,
  });
  if (confirmed) {
    await deleteAttemptsForQuestion(question.id);
    removeQuestion(question.id);
  }
}

function selectQuestion(id) {
  selectedId = id;
  render();
  onSelectionChange(getSelectedQuestion());
}

async function removeQuestion(id) {
  questions = questions.filter((q) => q.id !== id);
  await saveQuestions(questions);
  if (selectedId === id) {
    selectedId = null;
    onSelectionChange(null);
  }
  render();
}

async function addQuestion(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  const question = {
    id: crypto.randomUUID(),
    category: activeCategory,
    text: trimmed,
    createdAt: new Date().toISOString(),
    prepNotes: "",
  };
  questions.push(question);
  await saveQuestions(questions);
  render();
}

export async function updateQuestionPrepNotes(id, prepNotes) {
  const question = questions.find((q) => q.id === id);
  if (!question) return;
  question.prepNotes = prepNotes;
  await saveQuestions(questions);
}

function setActiveCategory(category) {
  activeCategory = category;
  for (const tab of tabsEl.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.category === category);
  }
  render();
}

export async function initQuestions(options = {}) {
  onSelectionChange = options.onSelectionChange ?? (() => {});
  questions = await getQuestions();

  tabsEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".tab");
    if (!btn) return;
    setActiveCategory(btn.dataset.category);
  });

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    addQuestion(inputEl.value);
    inputEl.value = "";
  });

  render();
}

export function getSelectedQuestion() {
  return questions.find((q) => q.id === selectedId) ?? null;
}

export function selectQuestionById(id) {
  const question = questions.find((q) => q.id === id);
  if (!question) return;

  // Only used to sync the sidebar before entering review mode for an
  // attempt (see onPlay in main.js) - skip if already selected, since
  // onSelectionChange also exits review mode, and re-firing it here (right
  // before re-entering review) races enterReviewMode's video setup against
  // exitReviewMode's fire-and-forget camera restore. Unlike a direct
  // sidebar click (selectQuestion below), this path never needs to force
  // an exit back to the live view.
  if (id === selectedId) return;

  setActiveCategory(question.category);
  selectQuestion(question.id);
}
