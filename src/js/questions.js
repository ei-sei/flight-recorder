import { getQuestions, saveQuestions } from "./store.js";
import { getAttemptCountForQuestion, deleteAttemptsForQuestion, renameQuestionInAttempts } from "./attempts.js";
import { showConfirm } from "./modal.js";
import { showContextMenu } from "./contextmenu.js";

let questions = [];
let activeCategory = "Behavioural";
let selectedId = null;
let onSelectionChange = () => {};
let draggedId = null;
let editingId = null;

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

    if (q.id === editingId) {
      item.appendChild(renderRenameInput(q));
      listEl.appendChild(item);
      continue;
    }

    item.draggable = true;

    const text = document.createElement("span");
    text.className = "question-item-text";
    text.textContent = q.text;

    item.appendChild(text);
    item.addEventListener("click", () => selectQuestion(q.id));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        { label: "Rename question", onClick: () => startRenaming(q.id) },
        { label: "Delete question", danger: true, onClick: () => confirmDeleteQuestion(q) },
      ]);
    });
    item.addEventListener("dragstart", (event) => {
      draggedId = q.id;
      event.dataTransfer.effectAllowed = "move";
      // WebKitGTK (Linux) needs real drag data set to complete the drag -
      // unlike Chromium, it won't fire drop otherwise.
      event.dataTransfer.setData("text/plain", q.id);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      clearDragOverMarkers();
      draggedId = null;
    });
    item.addEventListener("dragover", (event) => {
      if (!draggedId || draggedId === q.id) return;
      event.preventDefault();
      clearDragOverMarkers();
      const before = isDropBefore(event, item);
      item.classList.add(before ? "drag-over-before" : "drag-over-after");
    });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      if (!draggedId || draggedId === q.id) return;
      const before = isDropBefore(event, item);
      reorderQuestion(draggedId, q.id, before);
      draggedId = null;
    });
    listEl.appendChild(item);
  }
}

function renderRenameInput(question) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "question-item-edit-input";
  input.value = question.text;
  input.maxLength = 240;

  // Escape cancels without saving - blur normally commits, but Escape also
  // blurs the input, so this stops that blur from re-committing behind it.
  let cancelled = false;

  function commit() {
    if (cancelled) return;
    const trimmed = input.value.trim();
    editingId = null;
    if (trimmed && trimmed !== question.text) {
      renameQuestion(question.id, trimmed);
    } else {
      render();
    }
  }

  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      cancelled = true;
      editingId = null;
      render();
    }
  });

  queueMicrotask(() => {
    input.focus();
    input.select();
  });

  return input;
}

function startRenaming(id) {
  editingId = id;
  render();
}

async function renameQuestion(id, text) {
  const question = questions.find((q) => q.id === id);
  if (!question) return;
  question.text = text;
  await saveQuestions(questions);
  await renameQuestionInAttempts(id, text);
  if (selectedId === id) {
    // Only to refresh the question text shown above the record button.
    // renameQuestionInAttempts has already redrawn the log with the new
    // wording, so there is nothing here that should move its filter - and
    // moving it would narrow the list on a rename, which nobody asked for.
    onSelectionChange(getSelectedQuestion(), { filterAttemptLog: false });
  }
  render();
}

function isDropBefore(event, item) {
  const rect = item.getBoundingClientRect();
  return event.clientY - rect.top < rect.height / 2;
}

function clearDragOverMarkers() {
  for (const el of listEl.querySelectorAll(".drag-over-before, .drag-over-after")) {
    el.classList.remove("drag-over-before", "drag-over-after");
  }
}

async function reorderQuestion(draggedQuestionId, targetId, before) {
  const draggedIndex = questions.findIndex((q) => q.id === draggedQuestionId);
  if (draggedIndex === -1) return;
  const [dragged] = questions.splice(draggedIndex, 1);

  const targetIndex = questions.findIndex((q) => q.id === targetId);
  const insertAt = before ? targetIndex : targetIndex + 1;
  questions.splice(insertAt, 0, dragged);

  await saveQuestions(questions);
  render();
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

// `options` is forwarded untouched to onSelectionChange. The only thing in it
// today is filterAttemptLog, which separates "the user picked this question"
// from "this question was selected on the user's behalf" - see
// selectQuestionById.
function selectQuestion(id, options) {
  selectedId = id;
  render();
  onSelectionChange(getSelectedQuestion(), options);
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

export function selectQuestionById(id, options) {
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

  // The sidebar's own category tab does still move - the question has to be
  // visible in the bank for its selection to mean anything.
  setActiveCategory(question.category);
  selectQuestion(question.id, options);
}
