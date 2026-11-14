// Categories are a user-managed list (id + name), not the fixed Behavioural/
// Technical/Case tabs they used to be. Shared between the question bank
// (its own tabs, and moving a question between categories) and the attempt
// log (its filter tabs, and naming the folder a recording's video is saved
// under) - a stable id, same as a question's, so a rename never goes stale
// anywhere the way a plain string would.
//
// What a rename or a move touches is deliberately split by ownership: this
// module only ever changes the categories list itself. A question's own
// categoryId, and an attempt's category text snapshot, are changed by
// questions.js and attempts.js - the same split already drawn between
// renaming a question (questions.js) and that rename reaching the attempt
// log (attempts.js's renameQuestionInAttempts).
import { getCategories, saveCategories } from "./store.js";

let categories = [];
const listeners = [];

export async function initCategories() {
  categories = await getCategories();
}

export function getAllCategories() {
  return categories;
}

export function getCategoryName(id) {
  return categories.find((c) => c.id === id)?.name ?? "Unknown";
}

// Fires after any add/rename/delete, with the current list - lets the
// attempt log's filter tabs (which only ever read this list, never change
// it) stay in sync with whatever the question bank's tabs just did.
export function onCategoriesChanged(listener) {
  listeners.push(listener);
}

function notify() {
  for (const listener of listeners) listener(categories);
}

export async function addCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const category = { id: crypto.randomUUID(), name: trimmed };
  categories = [...categories, category];
  await saveCategories(categories);
  notify();
  return category;
}

export async function renameCategory(id, name) {
  const trimmed = name.trim();
  const existing = categories.find((c) => c.id === id);
  if (!trimmed || !existing || existing.name === trimmed) return;
  categories = categories.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
  await saveCategories(categories);
  notify();
}

// The caller (questions.js) decides whether a category is safe to delete -
// it already holds the question list this module deliberately doesn't know
// about - and only calls this once it's sure. The one rule enforced here,
// where it can't be bypassed by a caller that forgot: never down to zero,
// since every question (including the next one added) needs somewhere to
// live.
export async function deleteCategory(id) {
  if (categories.length <= 1) return false;
  categories = categories.filter((c) => c.id !== id);
  await saveCategories(categories);
  notify();
  return true;
}
