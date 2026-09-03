const overlayEl = document.getElementById("modal-overlay");
const titleEl = document.getElementById("modal-title");
const messageEl = document.getElementById("modal-message");
const cancelBtn = document.getElementById("modal-cancel");
const confirmBtn = document.getElementById("modal-confirm");
const typeConfirmRow = document.getElementById("modal-type-confirm");
const typeInput = document.getElementById("modal-type-input");
const actionsEl = document.querySelector("#modal-overlay .modal-actions");
const progressEl = document.getElementById("modal-progress");
const progressFillEl = document.getElementById("modal-progress-fill");
const progressDetailEl = document.getElementById("modal-progress-detail");

export function showConfirm({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  showCancel = true,
  requireTypedWord = null,
  // When true, confirming resolves the promise but leaves the overlay open
  // and under the caller's control - for a flow that continues in the same
  // dialog afterward (see setModalProgress/finishModal) rather than a prompt
  // that vanishes the instant it's answered. The caller must eventually hide
  // it themselves, via finishModal() or by closing it directly.
  keepOpenOnConfirm = false,
}) {
  return new Promise((resolve) => {
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = "btn " + (danger ? "btn-danger" : "btn-teal");
    cancelBtn.hidden = !showCancel;
    actionsEl.hidden = false;
    progressEl.hidden = true;

    typeConfirmRow.hidden = !requireTypedWord;
    typeInput.value = "";
    confirmBtn.disabled = Boolean(requireTypedWord);
    if (requireTypedWord) {
      typeInput.placeholder = `Type ${requireTypedWord} to confirm`;
    }

    overlayEl.hidden = false;
    if (requireTypedWord) {
      typeInput.focus();
    }

    function onInput() {
      confirmBtn.disabled = typeInput.value !== requireTypedWord;
    }

    function cleanup(result, hideOverlay) {
      if (hideOverlay) overlayEl.hidden = true;
      cancelBtn.hidden = false;
      confirmBtn.disabled = false;
      typeConfirmRow.hidden = true;
      typeInput.removeEventListener("input", onInput);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      overlayEl.removeEventListener("mousedown", onOverlayMouseDown);
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }

    function onCancel() {
      cleanup(false, true);
    }

    function onConfirm() {
      if (requireTypedWord && typeInput.value !== requireTypedWord) return;
      cleanup(true, !keepOpenOnConfirm);
    }

    function onOverlayMouseDown(event) {
      if (event.target === overlayEl) cleanup(false, true);
    }

    function onKeydown(event) {
      if (event.key === "Escape") cleanup(false, true);
    }

    if (requireTypedWord) {
      typeInput.addEventListener("input", onInput);
    }
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    overlayEl.addEventListener("mousedown", onOverlayMouseDown);
    document.addEventListener("keydown", onKeydown);
  });
}

export function showAlert({ title, message, closeLabel = "Close" }) {
  return showConfirm({ title, message, confirmLabel: closeLabel, showCancel: false });
}

// Only valid right after a keepOpenOnConfirm-flavoured showConfirm() resolves
// true - the overlay is still open at that point, with no listeners left on
// it (showConfirm's cleanup already tore them down), so nothing but this
// call drives it from here.
export function setModalProgress({ title, message, percent, detail }) {
  if (title !== undefined) titleEl.textContent = title;
  if (message !== undefined) messageEl.textContent = message;
  actionsEl.hidden = true;
  progressEl.hidden = false;
  const known = typeof percent === "number";
  progressFillEl.style.width = known ? `${percent}%` : "100%";
  // No Content-Length from the server means no real percentage to show -
  // an indeterminate sweep is honest about that; a fabricated number isn't.
  progressFillEl.classList.toggle("indeterminate", !known);
  progressDetailEl.textContent = detail ?? "";
}

// Turns the same dialog into a single-button "done" state and resolves once
// the user dismisses it, so the caller can await confirmation the way they
// already await showConfirm(). Restores the two-button layout afterward so
// the next ordinary showConfirm() isn't left in a stuck one-button state.
export function finishModal({ title, message, closeLabel = "OK" }) {
  titleEl.textContent = title;
  messageEl.textContent = message;
  progressEl.hidden = true;
  actionsEl.hidden = false;
  cancelBtn.hidden = true;
  confirmBtn.disabled = false;
  confirmBtn.textContent = closeLabel;
  confirmBtn.className = "btn btn-teal";

  return new Promise((resolve) => {
    function onDone() {
      confirmBtn.removeEventListener("click", onDone);
      overlayEl.removeEventListener("mousedown", onOverlayDone);
      document.removeEventListener("keydown", onKeydownDone);
      overlayEl.hidden = true;
      cancelBtn.hidden = false;
      resolve();
    }
    function onOverlayDone(event) {
      if (event.target === overlayEl) onDone();
    }
    function onKeydownDone(event) {
      if (event.key === "Escape" || event.key === "Enter") onDone();
    }
    confirmBtn.addEventListener("click", onDone);
    overlayEl.addEventListener("mousedown", onOverlayDone);
    document.addEventListener("keydown", onKeydownDone);
  });
}
