const menuEl = document.getElementById("context-menu");

export function showContextMenu(x, y, items) {
  menuEl.innerHTML = "";

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item" + (item.danger ? " danger" : "");

    if (item.checked !== undefined) {
      const check = document.createElement("span");
      check.className = "context-menu-check";
      if (item.checked) {
        check.innerHTML =
          '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 6.5l2.5 2.5 4.5-6" /></svg>';
      }
      btn.appendChild(check);
    }

    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);

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
