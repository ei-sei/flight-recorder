import { getQuestions, saveQuestions } from "./store.js";
import { getAttemptCountForQuestion } from "./attempts.js";
import { showConfirm } from "./modal.js";

let questions = [];
let activeCategory = "Behavioral";
let selectedId = null;
let onSelectionChange = () => {};

const listEl = document.getElementById("question-list");
const tabsEl = document.getElementById("question-category-tabs");
const formEl = document.getElementById("add-question-form");
const inputEl = document.getElementById("new-question-input");
const contextMenuEl = document.getElementById("question-context-menu");
const contextMenuDeleteBtn = document.getElementById("context-menu-delete");

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
      showContextMenu(event.clientX, event.clientY, q);
    });
    listEl.appendChild(item);
  }
}

function showContextMenu(x, y, question) {
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;
  contextMenuEl.hidden = false;
  contextMenuDeleteBtn.onclick = () => {
    hideContextMenu();
    confirmDeleteQuestion(question);
  };

  const dismiss = (event) => {
    if (!contextMenuEl.contains(event.target)) {
      hideContextMenu();
    }
  };
  document.addEventListener("click", dismiss, { once: true, capture: true });
}

function hideContextMenu() {
  contextMenuEl.hidden = true;
}

async function confirmDeleteQuestion(question) {
  const count = getAttemptCountForQuestion(question.id);
  const videoNote = count > 0 ? `You have recorded ${count} video${count === 1 ? "" : "s"} under this question. They'll stay in your attempt log, but you won't be able to select this question anymore.` : "This question has no recorded attempts.";

  const confirmed = await showConfirm({
    title: "Delete question?",
    message: videoNote,
    confirmLabel: "Delete",
    danger: true,
  });
  if (confirmed) {
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
  };
  questions.push(question);
  await saveQuestions(questions);
  render();
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
