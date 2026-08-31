function tickClock() {
  const clockEl = document.getElementById("clock");
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}

tickClock();
setInterval(tickClock, 1000);
