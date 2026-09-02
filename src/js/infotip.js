const tipEl = document.getElementById("info-tip");

let outsideClickHandler = null;
let currentTrigger = null;

export function showInfoTip(trigger, text) {
  if (currentTrigger === trigger) {
    hideInfoTip();
    return;
  }

  tipEl.textContent = text;
  tipEl.hidden = false;
  currentTrigger = trigger;

  const rect = trigger.getBoundingClientRect();
  const tipRect = tipEl.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - tipRect.width - 8);
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${rect.bottom + 6}px`;

  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler, true);
  }
  outsideClickHandler = (event) => {
    // Let the trigger's own click handler manage toggling instead of
    // pre-emptively closing here (capture phase always runs before the
    // trigger's own bubble-phase handler on the same click).
    if (trigger.contains(event.target)) return;
    if (!tipEl.contains(event.target)) hideInfoTip();
  };
  document.addEventListener("click", outsideClickHandler, { capture: true });
}

export function hideInfoTip() {
  tipEl.hidden = true;
  currentTrigger = null;
  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler, true);
    outsideClickHandler = null;
  }
}
