// app:// serves the UI; media:// streams recordings to the review player.
// Both are registered as privileged schemes in main.js, which has to happen
// before the app is ready - these handlers are attached afterwards.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const APP_ORIGIN = "app://flight-recorder";

// The same policy tauri.conf.json set, with Tauri's asset:/ipc: schemes
// swapped for media:. Sent as a header rather than a <meta> tag so it covers
// the page before a single byte of it is parsed.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' media: data:",
  "media-src 'self' media: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join("; ");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function isAppUrl(url) {
  return typeof url === "string" && (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`));
}

// app://flight-recorder/<path> -> a file under rootDir (the src/ folder, which
// sits inside the asar archive once packaged - fs reads through it).
export function createAppHandler(rootDir) {
  const root = path.resolve(rootDir);
  return async (request) => {
    const url = new URL(request.url);
    if (url.host !== "flight-recorder") return new Response("Not found", { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const body = await fsp.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "cache-control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

// "bytes=start-end" against a file of `size` bytes. Returns null for no
// header (whole file), { start, end } for a satisfiable range, or
// "unsatisfiable". Only single ranges - a <video> element never asks for more.
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "unsatisfiable";
  let start;
  let end;
  if (match[1] === "") {
    // Suffix range: the last N bytes.
    const length = Number(match[2]);
    if (length === 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

// The src the review <video> uses for a recording's absolute path.
export function mediaUrlFor(absolutePath) {
  return `media://library/${encodeURIComponent(absolutePath)}`;
}

// media://library/<encoded absolute path>, only for files inside the library.
// Range requests are what let the player seek, and start playing without
// reading the whole recording into memory first.
export function createMediaHandler(library) {
  return async (request) => {
    const url = new URL(request.url);
    if (url.host !== "library") return new Response("Not found", { status: 404 });
    let file;
    try {
      file = await library.inside(decodeURIComponent(url.pathname.slice(1)));
    } catch {
      return new Response("Forbidden", { status: 403 });
    }

    let size;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const headers = {
      "content-type": file.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4",
      "accept-ranges": "bytes",
    };
    const range = parseRange(request.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    if (!range) {
      headers["content-length"] = String(size);
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
    }
    headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["content-length"] = String(range.end - range.start + 1);
    return new Response(Readable.toWeb(fs.createReadStream(file, range)), { status: 206, headers });
  };
}
