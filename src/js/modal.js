const overlayEl = document.getElementById("modal-overlay");
const titleEl = document.getElementById("modal-title");
const messageEl = document.getElementById("modal-message");
const cancelBtn = document.getElementById("modal-cancel");
const confirmBtn = document.getElementById("modal-confirm");
const typeConfirmRow = document.getElementById("modal-type-confirm");
const typeInput = document.getElementById("modal-type-input");

export function showConfirm({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  showCancel = true,
  requireTypedWord = null,
}) {
  return new Promise((resolve) => {
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = "btn " + (danger ? "btn-danger" : "btn-teal");
    cancelBtn.hidden = !showCancel;

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

    function cleanup(result) {
      overlayEl.hidden = true;
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
      cleanup(false);
    }

    function onConfirm() {
      if (requireTypedWord && typeInput.value !== requireTypedWord) return;
      cleanup(true);
    }

    function onOverlayMouseDown(event) {
      if (event.target === overlayEl) cleanup(false);
    }

    function onKeydown(event) {
      if (event.key === "Escape") cleanup(false);
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
