const menuEl = document.getElementById("context-menu");

export function showContextMenu(x, y, items) {
  menuEl.innerHTML = "";

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item" + (item.danger ? " danger" : "");
    btn.textContent = item.label;
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
      if (!menuEl.contains(event.target)) hideContextMenu();
    },
    { once: true, capture: true },
  );
}

function hideContextMenu() {
  menuEl.hidden = true;
}
