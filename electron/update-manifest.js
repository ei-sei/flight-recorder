// The check that makes an update trustworthy: every file electron-updater is
// about to download must be listed, with the same SHA-512, in the release's
// update-manifest.json - and that manifest must carry a valid minisign
// signature from the release key. electron-updater then checks the download
// itself against those hashes. Plain Node, so it can be tested directly.

import { verifyMinisign, parsePublicKey } from "./minisign.js";

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`couldn't fetch ${url} (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

// info: electron-updater's UpdateInfo ({ version, files: [{ url, sha512 }] }).
// base: the URL the manifest and its .sig sit under.
export async function verifyUpdateInfo(info, { publicKey, base, fetchImpl = fetchBytes }) {
  const [manifestBytes, signature] = await Promise.all([
    fetchImpl(new URL("update-manifest.json", base).href),
    fetchImpl(new URL("update-manifest.json.sig", base).href),
  ]);
  verifyMinisign(manifestBytes, signature.toString("utf8"), parsePublicKey(publicKey));

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== info.version) throw new Error("the update's signed manifest is for a different version");
  const signed = new Map((manifest.files ?? []).map((file) => [file.url, file.sha512]));
  const files = info.files ?? [];
  if (files.length === 0) throw new Error("the update lists no files");
  for (const file of files) {
    if (signed.get(file.url) !== file.sha512) {
      throw new Error(`the update file ${file.url} doesn't match the release's signed manifest`);
    }
  }
}
