// Runs synchronously in <head>, before the first paint, so the window doesn't
// flash the wrong theme while main.js is still loading. Deliberately a plain
// script rather than a module: modules are deferred, which would put this
// after the paint and defeat the point.
//
// A file rather than inline in index.html because of the Content-Security-
// Policy (CONTENT_SECURITY_POLICY in electron/protocols.js): `script-src
// 'self'` means every script needs a file of its own.
//
// library.json (store.js) is the real source of truth for the theme. This is
// a mirror kept in localStorage purely because it can be read without
// awaiting.
try {
  if (localStorage.getItem("theme") !== "dark") {
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch (err) {
  // localStorage unavailable; the theme still applies once the store loads.
}
