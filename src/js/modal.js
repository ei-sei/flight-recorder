const overlayEl = document.getElementById("modal-overlay");
const titleEl = document.getElementById("modal-title");
const messageEl = document.getElementById("modal-message");
const cancelBtn = document.getElementById("modal-cancel");
const confirmBtn = document.getElementById("modal-confirm");

export function showConfirm({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = "btn " + (danger ? "btn-danger" : "btn-teal");
    overlayEl.hidden = false;

    function cleanup(result) {
      overlayEl.hidden = true;
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
      cleanup(true);
    }

    function onOverlayMouseDown(event) {
      if (event.target === overlayEl) cleanup(false);
    }

    function onKeydown(event) {
      if (event.key === "Escape") cleanup(false);
    }

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    overlayEl.addEventListener("mousedown", onOverlayMouseDown);
    document.addEventListener("keydown", onKeydown);
  });
}
