// Runs synchronously in <head>, before the first paint, so the window doesn't
// flash the wrong theme while main.js is still loading. Deliberately a plain
// script rather than a module: modules are deferred, which would put this
// after the paint and defeat the point.
//
// This lived inline in index.html until the app took a Content-Security-Policy
// (see tauri.conf.json). Tauri adds its own nonce to the scripts it injects,
// but not to ours, so `script-src 'self'` means every script we write needs a
// file. Nothing of value was lost: it was never readable in the markup either.
//
// The Tauri store is the real source of truth for the theme. This is a mirror
// kept in localStorage purely because it can be read without awaiting.
try {
  if (localStorage.getItem("theme") !== "dark") {
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch (err) {
  // localStorage unavailable; the theme still applies once the store loads.
}
