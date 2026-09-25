// Builds the fr-whisper speech-to-text helper (native/) and stages it where
// electron-builder picks it up: native/dist/<arch>/, with Electron's arch
// names (x64, arm64). `npm run build:helper` builds for this machine; pass
// Rust target triples to build others, e.g. both Macs on one runner:
//   node scripts/build-helper.js x86_64-apple-darwin aarch64-apple-darwin
//
// cargo runs from native/ on purpose: that's how it finds
// native/.cargo/config.toml, which keeps whisper.cpp from being compiled
// for this machine's CPU. --manifest-path from elsewhere would skip it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const native = path.join(import.meta.dirname, "..", "native");
const exe = process.platform === "win32" ? "fr-whisper.exe" : "fr-whisper";

function electronArch(triple) {
  if (triple.startsWith("x86_64")) return "x64";
  if (triple.startsWith("aarch64")) return "arm64";
  throw new Error(`no Electron arch for ${triple}`);
}

const hostArch = { x64: "x64", arm64: "arm64" }[process.arch];
const builds = process.argv.length > 2 ? process.argv.slice(2).map((t) => ({ target: t, arch: electronArch(t) })) : [{ target: null, arch: hostArch }];

for (const { target, arch } of builds) {
  const args = ["build", "--release", "--locked", ...(target ? ["--target", target] : [])];
  console.log(`cargo ${args.join(" ")}  (in native/)`);
  execFileSync("cargo", args, { cwd: native, stdio: "inherit" });
  const built = path.join(native, "target", ...(target ? [target] : []), "release", exe);
  const staged = path.join(native, "dist", arch, exe);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.copyFileSync(built, staged);
  console.log(`staged ${path.relative(process.cwd(), staged)}`);
}
