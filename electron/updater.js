// Update checks and installs, through electron-updater and the app's GitHub
// releases - one of the only two things in the app that use the network.
//
// electron-updater trusts whatever the release's latest*.yml says a download
// should hash to. Those files aren't signed, so every release also carries
// update-manifest.json, signed in CI with the key the Tauri builds' updater
// used. An update is only downloaded once its file list matches that signed
// manifest, which is what the download is then checked against.

import { app, shell, BrowserWindow } from "electron";
import updaterPkg from "electron-updater";
import pkg from "../package.json" with { type: "json" };

import { verifyUpdateInfo } from "./update-manifest.js";

const { autoUpdater } = updaterPkg;

const RELEASES_URL = "https://github.com/ei-sei/flight-recorder/releases";

// minisign key AB005F32653B653B - the same public key tauri.conf.json held.
// A test build can carry its own (package.json "updatePublicKey", set at
// build time and sealed in the app archive with everything else).
const PUBLIC_KEY = pkg.updatePublicKey ?? "RWQ7ZTtlMl8Aq8gSomA72oSj54y+bnXqRTQP8bdU823WejVdmues2pfP";

// Where a version's signed manifest lives. Overridable the same way, so a
// test build can point at a local server.
function manifestBase(version) {
  return pkg.updateManifestBase ?? `${RELEASES_URL}/download/v${version}/`;
}

export function createUpdater() {
  autoUpdater.autoDownload = false;
  // Only ever installed when the user says so, from the update dialog.
  autoUpdater.autoInstallOnAppQuit = false;
  let verifiedVersion = null;

  return {
    // Resolves to null when up to date, { version } when there's an update,
    // or { disabled: reason } when this copy doesn't update at all - running
    // from source isn't a failure, and shouldn't be reported as one.
    async check() {
      if (!app.isPackaged) {
        return { disabled: "Updates are checked in the installed app, not when running from source." };
      }
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      await verifyUpdateInfo(result.updateInfo, {
        publicKey: PUBLIC_KEY,
        base: manifestBase(result.updateInfo.version),
      });
      verifiedVersion = result.updateInfo.version;
      return { version: verifiedVersion };
    },

    async install() {
      if (!verifiedVersion) throw new Error("Check for updates first.");
      // Installing in place on macOS needs an Apple-signed app, which this
      // isn't yet - so the download page opens instead.
      if (process.platform === "darwin") {
        await shell.openExternal(`${RELEASES_URL}/latest`);
        return;
      }
      await autoUpdater.downloadUpdate();
      // Quits, installs and starts the new version. On Linux .deb/.rpm
      // installs, the system asks for an admin password first.
      //
      // For an AppImage, electron-updater starts the new version *before*
      // this one has quit - which would find the single-instance lock still
      // held and quit straight away, leaving the user with no app. So the
      // window goes first (freeing the camera too) and the lock is let go
      // before handing over.
      setImmediate(() => {
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
        app.releaseSingleInstanceLock();
        autoUpdater.quitAndInstall(true, true);
      });
    },
  };
}
