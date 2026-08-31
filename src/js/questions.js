import { getQuestions, saveQuestions } from "./store.js";

let questions = [];
let activeCategory = "Behavioral";
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

    const remove = document.createElement("button");
    remove.className = "question-item-remove";
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = "Remove question";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeQuestion(q.id);
    });

    item.appendChild(text);
    item.appendChild(remove);
    item.addEventListener("click", () => selectQuestion(q.id));
    listEl.appendChild(item);
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
