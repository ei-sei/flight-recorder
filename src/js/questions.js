import { getQuestions, saveQuestions } from "./store.js";
import { getAttemptCountForQuestion, deleteAttemptsForQuestion, renameQuestionInAttempts, updateCategoryTextInAttempts } from "./attempts.js";
import { getAllCategories, addCategory, renameCategory, deleteCategory, onCategoriesChanged } from "./categories.js";
import { showConfirm, showAlert } from "./modal.js";
import { showContextMenu } from "./contextmenu.js";

let questions = [];
let activeCategoryId = null;
let selectedId = null;
let onSelectionChange = () => {};
let editingId = null;
let editingCategoryId = null;

const listEl = document.getElementById("question-list");
const tabsEl = document.getElementById("question-category-tabs");
const formEl = document.getElementById("add-question-form");
const inputEl = document.getElementById("new-question-input");

function render() {
  const filtered = questions.filter((q) => q.categoryId === activeCategoryId);
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

    const text = document.createElement("span");
    text.className = "question-item-text";
    text.textContent = q.text;

    item.appendChild(text);
    item.addEventListener("click", () => {
      // The click that ends a drag lands on the question that was dragged;
      // it isn't a request to select it.
      if (suppressNextClick) return;
      selectQuestion(q.id);
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const moveItems = getAllCategories()
        .filter((c) => c.id !== q.categoryId)
        .map((c) => ({ label: `Move to ${c.name}`, onClick: () => moveQuestionToCategory(q, c) }));
      showContextMenu(event.clientX, event.clientY, [
        { label: "Rename question", onClick: () => startRenaming(q.id) },
        ...moveItems,
        { label: "Delete question", danger: true, onClick: () => confirmDeleteQuestion(q) },
      ]);
    });
    item.addEventListener("pointerdown", (event) => watchForDrag(event, item));
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

// Reordering by dragging, with pointer events rather than HTML5 drag-and-
// drop. That gave a translucent ghost copy under the cursor, only registered
// a drop made directly on top of another question, and moved nothing until
// the drop. Here the question itself follows the pointer, the others slide
// out of its way as it goes, and letting go anywhere - including the empty
// space below the last question - puts it where the gap is.
//
// Positions are worked out in the list's scrolled content coordinates, from
// where everything sat when the drag began, so auto-scrolling a long list
// mid-drag doesn't throw them off.
const DRAG_THRESHOLD_PX = 4;
const EDGE_SCROLL_PX = 32;
const MAX_SCROLL_STEP_PX = 14;
let drag = null;
let suppressNextClick = false;

// Every press might become a drag, but only once the pointer has moved a few
// pixels - until then it's an ordinary click that selects the question.
function watchForDrag(event, item) {
  if (event.button !== 0 || drag) return;
  const pointerId = event.pointerId;
  const startY = event.clientY;
  item.setPointerCapture(pointerId);

  const onMove = (e) => {
    if (e.pointerId !== pointerId) return;
    if (!drag) {
      if (Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      beginDrag(item, startY);
    }
    drag.pointerY = e.clientY;
    layoutDrag();
  };
  const onEnd = (e) => {
    if (e.pointerId !== pointerId) return;
    item.removeEventListener("pointermove", onMove);
    item.removeEventListener("pointerup", onEnd);
    item.removeEventListener("pointercancel", onEnd);
    if (drag) finishDrag(e.type === "pointerup");
  };
  item.addEventListener("pointermove", onMove);
  item.addEventListener("pointerup", onEnd);
  item.addEventListener("pointercancel", onEnd);
}

function contentY(clientY) {
  return clientY - listEl.getBoundingClientRect().top + listEl.scrollTop;
}

function beginDrag(item, startClientY) {
  const items = [...listEl.querySelectorAll(".question-item")];
  const slots = items.map((el) => {
    const rect = el.getBoundingClientRect();
    return { el, top: contentY(rect.top), height: rect.height };
  });
  const index = items.indexOf(item);
  const gap = parseFloat(getComputedStyle(item).marginBottom) || 0;
  drag = {
    item,
    id: item.dataset.id,
    slots,
    index,
    target: index,
    // How far each question it passes has to move to close the gap it left.
    shift: slots[index].height + gap,
    startY: contentY(startClientY),
    pointerY: startClientY,
    frame: requestAnimationFrame(autoScroll),
  };
  item.classList.add("dragging");
  listEl.classList.add("reordering");
}

function layoutDrag() {
  const { item, slots, index, shift } = drag;
  const own = slots[index];
  const offset = contentY(drag.pointerY) - drag.startY;

  // Where it would land goes by the pointer, unclamped, so dragging out past
  // the last question still means "last" whatever the questions' heights.
  const centre = own.top + own.height / 2 + offset;
  let target = 0;
  slots.forEach((slot, i) => {
    if (i !== index && slot.top + slot.height / 2 < centre) target++;
  });
  drag.target = target;

  // What's drawn stays inside the list, rather than trailing off the panel.
  const first = slots[0];
  const last = slots[slots.length - 1];
  const shown = Math.min(last.top + last.height - own.top - own.height, Math.max(first.top - own.top, offset));
  item.style.transform = `translateY(${shown}px)`;

  slots.forEach((slot, i) => {
    if (i === index) return;
    let move = 0;
    if (index < i && i <= target) move = -shift;
    else if (target <= i && i < index) move = shift;
    slot.el.style.transform = move ? `translateY(${move}px)` : "";
  });
}

// Scrolls a long list while the pointer is held near its top or bottom edge,
// faster the further past the edge it is.
function autoScroll() {
  if (!drag) return;
  const rect = listEl.getBoundingClientRect();
  let step = 0;
  if (drag.pointerY < rect.top + EDGE_SCROLL_PX) step = -(rect.top + EDGE_SCROLL_PX - drag.pointerY) / 3;
  else if (drag.pointerY > rect.bottom - EDGE_SCROLL_PX) step = (drag.pointerY - rect.bottom + EDGE_SCROLL_PX) / 3;
  step = Math.max(-MAX_SCROLL_STEP_PX, Math.min(MAX_SCROLL_STEP_PX, step));
  if (step) {
    const before = listEl.scrollTop;
    listEl.scrollTop += step;
    if (listEl.scrollTop !== before) layoutDrag();
  }
  drag.frame = requestAnimationFrame(autoScroll);
}

async function finishDrag(commit) {
  const { item, id, slots, index, target } = drag;
  cancelAnimationFrame(drag.frame);
  drag = null;
  suppressNextClick = true;
  setTimeout(() => {
    suppressNextClick = false;
  });
  listEl.classList.remove("reordering");

  if (!commit || target === index) {
    // Everything glides back to where it was.
    item.classList.remove("dragging");
    for (const slot of slots) slot.el.style.transform = "";
    return;
  }

  const others = slots.filter((_, i) => i !== index).map((slot) => slot.el.dataset.id);
  const fromTop = item.getBoundingClientRect().top;
  if (target >= others.length) await reorderQuestion(id, others[others.length - 1], false);
  else await reorderQuestion(id, others[target], true);

  // The list is redrawn in its new order; start the dropped question from
  // where it was let go and ease it the last few pixels into its slot,
  // instead of it jumping there.
  const dropped = listEl.querySelector(`.question-item[data-id="${CSS.escape(id)}"]`);
  if (!dropped) return;
  dropped.style.transition = "none";
  dropped.style.transform = `translateY(${fromTop - dropped.getBoundingClientRect().top}px)`;
  dropped.getBoundingClientRect();
  dropped.style.transition = "";
  dropped.style.transform = "";
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
    categoryId: activeCategoryId,
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

async function moveQuestionToCategory(question, category) {
  question.categoryId = category.id;
  await saveQuestions(questions);
  // Kept in sync rather than left as a snapshot of whichever category the
  // question was in when each attempt was recorded - the same choice
  // renameQuestionInAttempts already makes for the question's text.
  await updateCategoryTextInAttempts([question.id], category.name);
  render();
}

function setActiveCategory(id) {
  activeCategoryId = id;
  renderCategoryTabs();
  render();
}

// Category tabs are fully re-rendered (add/rename/delete and the "+"
// control all live here) rather than patched in place - there's no fixed
// set of them any more to patch, and this runs rarely enough (a click, or a
// categories.js change event) that rebuilding is simpler than diffing.
function renderCategoryTabs() {
  tabsEl.innerHTML = "";
  const categories = getAllCategories();

  for (const category of categories) {
    if (category.id === editingCategoryId) {
      tabsEl.appendChild(renderCategoryRenameInput(category));
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "tab" + (category.id === activeCategoryId ? " active" : "");
    btn.dataset.categoryId = category.id;
    btn.type = "button";
    btn.textContent = category.name;
    btn.addEventListener("click", () => setActiveCategory(category.id));
    btn.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        { label: "Rename category", onClick: () => startRenamingCategory(category.id) },
        { label: "Delete category", danger: true, onClick: () => confirmDeleteCategory(category) },
      ]);
    });
    tabsEl.appendChild(btn);
  }

  const addBtn = document.createElement("button");
  addBtn.className = "tab tab-add";
  addBtn.type = "button";
  addBtn.title = "Add category";
  addBtn.setAttribute("aria-label", "Add category");
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    tabsEl.replaceChild(renderAddCategoryInput(), addBtn);
  });
  tabsEl.appendChild(addBtn);

  // activeCategoryId can be null only on first render, before categories.js
  // has loaded (initQuestions awaits that before ever calling this) - and
  // after a delete, the same fallback renameQuestionInAttempts's sibling
  // tabs use, in case the category just deleted was the active one.
  if (!categories.some((c) => c.id === activeCategoryId) && categories.length > 0) {
    activeCategoryId = categories[0].id;
    renderCategoryTabs();
  }
}

function renderCategoryRenameInput(category) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-edit-input";
  input.value = category.name;
  input.maxLength = 60;

  let cancelled = false;
  function commit() {
    if (cancelled) return;
    const trimmed = input.value.trim();
    editingCategoryId = null;
    if (trimmed && trimmed !== category.name) {
      renameCategoryFlow(category.id, trimmed);
    } else {
      renderCategoryTabs();
    }
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      cancelled = true;
      editingCategoryId = null;
      input.blur();
      renderCategoryTabs();
    }
  });
  input.addEventListener("blur", commit);
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

function renderAddCategoryInput() {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-edit-input";
  input.placeholder = "Category name";
  input.maxLength = 60;

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const trimmed = input.value.trim();
    if (trimmed) {
      const category = await addCategory(trimmed);
      activeCategoryId = category.id;
    }
    renderCategoryTabs();
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") {
      committed = true; // blur still fires; this just skips adding anything
      renderCategoryTabs();
    }
  });
  input.addEventListener("blur", commit);
  queueMicrotask(() => input.focus());
  return input;
}

function startRenamingCategory(id) {
  editingCategoryId = id;
  renderCategoryTabs();
}

async function renameCategoryFlow(id, name) {
  await renameCategory(id, name);
  // Every question currently in this category snapshot the new name into
  // their attempts too, the same as moveQuestionToCategory does for one.
  const questionIds = questions.filter((q) => q.categoryId === id).map((q) => q.id);
  await updateCategoryTextInAttempts(questionIds, name);
  renderCategoryTabs();
}

async function confirmDeleteCategory(category) {
  const categories = getAllCategories();
  if (categories.length <= 1) {
    await showAlert({ title: "Can't delete this category", message: "At least one category has to remain." });
    return;
  }
  const count = questions.filter((q) => q.categoryId === category.id).length;
  if (count > 0) {
    await showAlert({
      title: "Can't delete this category",
      message: `It still has ${count} question${count === 1 ? "" : "s"} in it. Move or delete ${count === 1 ? "it" : "them"} first.`,
    });
    return;
  }
  const confirmed = await showConfirm({
    title: "Delete category?",
    message: `Delete “${category.name}”? This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (confirmed) await deleteCategory(category.id);
}

// initCategories() (categories.js) must already have been awaited by the
// caller (main.js, before this and initAttempts) - both this panel's tabs
// and the attempt log's rely on getAllCategories() having real data from
// the very first render, not whatever it happens to catch up to later.
export async function initQuestions(options = {}) {
  onSelectionChange = options.onSelectionChange ?? (() => {});
  questions = await getQuestions();
  activeCategoryId = getAllCategories()[0]?.id ?? null;

  onCategoriesChanged(() => renderCategoryTabs());

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    addQuestion(inputEl.value);
    inputEl.value = "";
  });

  renderCategoryTabs();
  render();
}

export function getSelectedQuestion() {
  return questions.find((q) => q.id === selectedId) ?? null;
}

export function getQuestionCount() {
  return questions.length;
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
  setActiveCategory(question.categoryId);
  selectQuestion(question.id, options);
}
