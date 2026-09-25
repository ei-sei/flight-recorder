// Runs the app from source: `npm start`.
//
// Goes through this script rather than calling electron directly because
// VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE=1 (VS Code is an
// Electron app itself), which makes Electron start as plain Node and fail on
// the first line of main.js. Cleared here so the app starts the same from any
// terminal, on any OS.
import { spawn } from "node:child_process";
import electron from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
