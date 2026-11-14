const menuEl = document.getElementById("context-menu");

let outsideClickHandler = null;
// The one open submenu flyout (at most one at a time - these menus never go
// more than one level deep) and the item it belongs to, so switching to a
// different submenu item closes it first rather than stacking a second one.
let submenu = null;
let submenuOwner = null;
let submenuCloseTimer = null;

function closeSubmenu() {
  clearTimeout(submenuCloseTimer);
  submenuCloseTimer = null;
  submenu?.remove();
  submenu = null;
  submenuOwner?.classList.remove("open");
  submenuOwner = null;
}

// Shared by the top-level menu and a submenu flyout: drawn at (x, y) first,
// then nudged back on-screen once its real size is known - see the comment
// on the original clamping logic below, which this is lifted from.
function positionPanel(panel, x, y) {
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  panel.hidden = false;
  const EDGE_MARGIN = 4;
  const rect = panel.getBoundingClientRect();
  const left = rect.right > window.innerWidth ? Math.max(EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN) : x;
  const top = rect.bottom > window.innerHeight ? Math.max(EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN) : y;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  return { left, top, width: rect.width };
}

function buildItems(panel, items) {
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item" + (item.danger ? " danger" : "");

    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);

    if (item.items) {
      // A submenu item - its own flyout, not something it does on click.
      const chevron = document.createElement("span");
      chevron.className = "context-menu-chevron";
      chevron.textContent = "›";
      btn.appendChild(chevron);

      btn.addEventListener("mouseenter", () => {
        clearTimeout(submenuCloseTimer);
        if (submenuOwner === btn) return;
        closeSubmenu();
        const flyout = document.createElement("div");
        flyout.className = "context-menu context-submenu";
        buildItems(flyout, item.items);
        document.body.appendChild(flyout);
        const ownRect = btn.getBoundingClientRect();
        const { width } = positionPanel(flyout, ownRect.right - 2, ownRect.top - 4);
        // Opened past the right edge and got clamped back under the
        // trigger - open to its left instead, or it would sit on top of it.
        if (ownRect.right - 2 + width > window.innerWidth) {
          flyout.style.left = `${Math.max(4, ownRect.left - width + 2)}px`;
        }
        // The pointer crossing from the item into the flyout passes through
        // neither for a moment - keep it open while the pointer is on
        // either one, and only start the close timer once it's on neither.
        flyout.addEventListener("mouseenter", () => clearTimeout(submenuCloseTimer));
        flyout.addEventListener("mouseleave", () => {
          submenuCloseTimer = setTimeout(closeSubmenu, 150);
        });
        submenu = flyout;
        submenuOwner = btn;
        btn.classList.add("open");
      });
      // A short delay before closing: moving the pointer from the item to
      // the flyout crosses a few pixels of neither, and closing immediately
      // on that gap is what made every earlier version of this feel broken.
      btn.addEventListener("mouseleave", () => {
        submenuCloseTimer = setTimeout(closeSubmenu, 150);
      });
    } else {
      let switchEl = null;
      if (item.checked !== undefined) {
        switchEl = document.createElement("span");
        switchEl.className = "menu-switch" + (item.checked ? " checked" : "");
        switchEl.innerHTML = '<span class="menu-switch-thumb"></span>';
        btn.appendChild(switchEl);
      }

      btn.addEventListener("mouseenter", () => {
        clearTimeout(submenuCloseTimer);
        if (submenuOwner && submenuOwner !== btn) closeSubmenu();
      });
      btn.addEventListener("click", () => {
        item.onClick();
        if (switchEl) {
          // Toggle items stay open so several can be flipped in one go.
          switchEl.classList.toggle("checked");
        } else {
          hideContextMenu();
        }
      });
    }
    panel.appendChild(btn);
  }
}

export function showContextMenu(x, y, items, { trigger } = {}) {
  menuEl.innerHTML = "";
  closeSubmenu();
  buildItems(menuEl, items);

  // Positioned at the cursor first, then clamped - the menu has to actually
  // be in the DOM and visible before its real size can be measured, and
  // only then is it known whether it would run off the right or bottom
  // edge. Right-clicking near either edge of the window used to render the
  // menu partly or fully off-screen with no way to reach the cut-off items.
  positionPanel(menuEl, x, y);

  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler, true);
  }
  outsideClickHandler = (event) => {
    // Let the trigger's own click handler manage toggling instead of
    // pre-emptively closing here, which would race ahead of it (this
    // capture-phase listener always runs before the trigger's own
    // bubble-phase handler on the same click).
    if (trigger && trigger.contains(event.target)) return;
    if (!menuEl.contains(event.target) && !submenu?.contains(event.target)) hideContextMenu();
  };
  document.addEventListener("click", outsideClickHandler, { capture: true });
}

export function hideContextMenu() {
  menuEl.hidden = true;
  closeSubmenu();
  if (outsideClickHandler) {
    document.removeEventListener("click", outsideClickHandler, true);
    outsideClickHandler = null;
  }
}

export function isContextMenuVisible() {
  return !menuEl.hidden;
}
