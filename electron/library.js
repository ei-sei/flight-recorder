// Everything the renderer may do on disk, and the rule that keeps it inside
// Videos/flight-recorder. Plain Node, no Electron import, so it can be tested
// under `node --test` against a real temporary folder.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// realpath() of the deepest part of `target` that exists, with the rest
// appended. A path that doesn't exist yet (a file about to be written, a
// folder about to be made) still has to be checked, and checking the raw
// string would let a symlinked parent point it anywhere.
async function realpathNearest(target) {
  let existing = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      return path.join(real, ...rest.reverse());
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) return path.join(existing, ...rest.reverse());
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isWithin(root, target) {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return !path.isAbsolute(rel) && rel.split(path.sep)[0] !== "..";
}

async function retryRename(from, to) {
  // Windows refuses a rename while anything else has the destination open -
  // antivirus scanning a file it just saw written, or OneDrive syncing a
  // redirected Videos folder. It clears within moments.
  const delays = [20, 50, 100, 200, 400];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const transient = err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES";
      if (!transient || attempt >= delays.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // unreadable folders count as empty rather than failing the lot
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // gone between readdir and stat
      }
    }
  }
  return total;
}

// root: the library folder, Videos/flight-recorder.
// legacyStoreFile: the store's pre-portable location in the old app-data
// folder, readable (never writable) so store.js can migrate from it once.
export function createLibrary({ root, legacyStoreFile = null }) {
  // The library root is itself allowed through a symlink (a Videos folder
  // moved to another drive, say), so compare against where it really is.
  async function realRoot() {
    return realpathNearest(root);
  }

  // Throws unless `target` is the library folder or something inside it.
  async function inside(target) {
    if (typeof target !== "string" || target === "") throw new Error("invalid path");
    const [base, real] = await Promise.all([realRoot(), realpathNearest(target)]);
    if (!isWithin(base, real)) throw new Error("path is outside the library folder");
    return real;
  }

  // Serialised per file, so two saves of the same store can't interleave
  // their temp-file-and-rename steps and leave the older one on disk.
  const writeChains = new Map();

  return {
    root,
    inside,

    async readFile(target) {
      return fs.readFile(await inside(target));
    },

    async writeFile(target, bytes) {
      await fs.writeFile(await inside(target), bytes);
    },

    async mkdir(target, { recursive = false } = {}) {
      await fs.mkdir(await inside(target), { recursive });
    },

    async exists(target) {
      try {
        await fs.access(await inside(target));
        return true;
      } catch (err) {
        if (err.message === "path is outside the library folder") throw err;
        return false;
      }
    },

    async remove(target, { recursive = false } = {}) {
      await fs.rm(await inside(target), { recursive });
    },

    async size() {
      return directorySize(await realRoot());
    },

    // null when the file doesn't exist yet - an empty store, same as a
    // first launch.
    async readText(target) {
      const file = target === "flight-recorder.json" ? legacyStoreFile : await inside(target);
      if (!file) return null;
      try {
        return await fs.readFile(file, "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    // Written to a temp file and renamed over the original, so a crash or a
    // full disk mid-write leaves the previous library.json intact rather than
    // a half-written one. Creates the folder first: Reset data deletes it
    // and then saves.
    async writeTextAtomic(target, text) {
      const file = await inside(target);
      const previous = writeChains.get(file) ?? Promise.resolve();
      const write = previous.then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        try {
          await fs.writeFile(temp, text, "utf8");
          await retryRename(temp, file);
        } catch (err) {
          await fs.rm(temp, { force: true });
          throw err;
        }
      });
      writeChains.set(file, write.catch(() => {}));
      return write;
    },
  };
}
