const menuEl = document.getElementById("context-menu");
const submenuEl = document.getElementById("context-submenu");

export function showContextMenu(x, y, items) {
  renderMenu(menuEl, items, x, y);
  submenuEl.hidden = true;

  document.addEventListener(
    "click",
    (event) => {
      if (!menuEl.contains(event.target) && !submenuEl.contains(event.target)) {
        hideContextMenu();
      }
    },
    { once: true, capture: true },
  );
}

function renderMenu(container, items, x, y) {
  container.innerHTML = "";

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item" + (item.danger ? " danger" : "");

    if (item.children) {
      btn.classList.add("has-submenu");
      btn.textContent = item.label;
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const rect = btn.getBoundingClientRect();
        renderMenu(submenuEl, item.children, rect.right + 4, rect.top);
      });
    } else {
      btn.textContent = item.label;
      btn.addEventListener("click", () => {
        hideContextMenu();
        item.onClick();
      });
    }
    container.appendChild(btn);
  }

  container.style.left = `${x}px`;
  container.style.top = `${y}px`;
  container.hidden = false;
}

function hideContextMenu() {
  menuEl.hidden = true;
  submenuEl.hidden = true;
}
