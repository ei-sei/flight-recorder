const menuEl = document.getElementById("context-menu");

let outsideClickHandler = null;

export function showContextMenu(x, y, items, { trigger } = {}) {
  menuEl.innerHTML = "";

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item" + (item.danger ? " danger" : "");

    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);

    let switchEl = null;
    if (item.checked !== undefined) {
      switchEl = document.createElement("span");
      switchEl.className = "menu-switch" + (item.checked ? " checked" : "");
      switchEl.innerHTML = '<span class="menu-switch-thumb"></span>';
      btn.appendChild(switchEl);
    }

    btn.addEventListener("click", () => {
      item.onClick();
      if (switchEl) {
        // Toggle items stay open so several can be flipped in one go.
        switchEl.classList.toggle("checked");
      } else {
        hideContextMenu();
      }
    });
    menuEl.appendChild(btn);
  }

  // Positioned at the cursor first, then clamped - the menu has to actually
  // be in the DOM and visible before its real size can be measured, and
  // only then is it known whether it would run off the right or bottom
  // edge. Right-clicking near either edge of the window used to render the
  // menu partly or fully off-screen with no way to reach the cut-off items.
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  menuEl.hidden = false;

  const EDGE_MARGIN = 4;
  const rect = menuEl.getBoundingClientRect();
  const left = rect.right > window.innerWidth ? Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN) : x;
  const top =
    rect.bottom > window.innerHeight ? Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN) : y;
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;

  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler, true);
  }
  outsideClickHandler = (event) => {
    // Let the trigger's own click handler manage toggling instead of
    // pre-emptively closing here, which would race ahead of it (this
    // capture-phase listener always runs before the trigger's own
    // bubble-phase handler on the same click).
    if (trigger && trigger.contains(event.target)) return;
    if (!menuEl.contains(event.target)) hideContextMenu();
  };
  document.addEventListener("click", outsideClickHandler, { capture: true });
}

export function hideContextMenu() {
  menuEl.hidden = true;
  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler, true);
    outsideClickHandler = null;
  }
}

export function isContextMenuVisible() {
  return !menuEl.hidden;
}
