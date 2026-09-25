// Writes update-manifest.json from a release's latest*.yml files:
//   node scripts/update-manifest.js <folder with latest*.yml> [out file]
//
// The manifest lists every file electron-updater may download, with its
// SHA-512. CI signs it with the release key (`tauri signer sign`), and the
// app refuses any update whose files aren't in it - see
// electron/update-manifest.js.
//
// latest*.yml is parsed by hand rather than with a YAML library: its shape is
// fixed by electron-builder, and only three fields are needed.
import fs from "node:fs";
import path from "node:path";

export function readUpdateYml(text) {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1].trim();
  const files = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const url = /^\s*-\s+url:\s*(.+)$/.exec(line);
    if (url) {
      current = { url: url[1].trim() };
      files.push(current);
      continue;
    }
    const sha = /^\s+sha512:\s*(.+)$/.exec(line);
    if (sha && current && !current.sha512) current.sha512 = sha[1].trim();
  }
  if (!version || files.length === 0 || files.some((f) => !f.sha512)) {
    throw new Error("unexpected latest*.yml format");
  }
  return { version, files };
}

export function buildManifest(ymlTexts) {
  const parsed = ymlTexts.map(readUpdateYml);
  const versions = new Set(parsed.map((p) => p.version));
  if (versions.size !== 1) throw new Error(`latest*.yml files disagree on the version: ${[...versions].join(", ")}`);
  return { version: parsed[0].version, files: parsed.flatMap((p) => p.files) };
}

if (process.argv[1] === import.meta.filename) {
  const dir = process.argv[2];
  const out = process.argv[3] ?? path.join(dir, "update-manifest.json");
  const ymls = fs.readdirSync(dir).filter((name) => /^latest.*\.yml$/.test(name));
  if (ymls.length === 0) throw new Error(`no latest*.yml in ${dir}`);
  const manifest = buildManifest(ymls.map((name) => fs.readFileSync(path.join(dir, name), "utf8")));
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${out}: version ${manifest.version}, ${manifest.files.length} files from ${ymls.join(", ")}`);
}
