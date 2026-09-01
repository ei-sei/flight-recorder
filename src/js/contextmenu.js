const menuEl = document.getElementById("context-menu");

export function showContextMenu(x, y, items, { trigger } = {}) {
  menuEl.innerHTML = "";

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item" + (item.danger ? " danger" : "");

    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);

    if (item.checked !== undefined) {
      const switchEl = document.createElement("span");
      switchEl.className = "menu-switch" + (item.checked ? " checked" : "");
      switchEl.innerHTML = '<span class="menu-switch-thumb"></span>';
      btn.appendChild(switchEl);
    }

    btn.addEventListener("click", () => {
      hideContextMenu();
      item.onClick();
    });
    menuEl.appendChild(btn);
  }

  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
  menuEl.hidden = false;

  document.addEventListener(
    "click",
    (event) => {
      // Let the trigger's own click handler manage toggling instead of
      // pre-emptively closing here, which would race ahead of it (this
      // capture-phase listener always runs before the trigger's own
      // bubble-phase handler on the same click).
      if (trigger && trigger.contains(event.target)) return;
      if (!menuEl.contains(event.target)) hideContextMenu();
    },
    { once: true, capture: true },
  );
}

export function hideContextMenu() {
  menuEl.hidden = true;
}

export function isContextMenuVisible() {
  return !menuEl.hidden;
}
