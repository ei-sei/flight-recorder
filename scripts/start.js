// Runs the app from source.
//
//   npm start      your real library, as the installed app would use it
//   npm run dev    a separate library and profile under .dev/, seeded with
//                  sample questions - safe to run next to the installed app,
//                  and nothing done in it touches your real recordings
//
// Goes through this script rather than calling electron directly because
// VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE=1 (VS Code is an
// Electron app itself), which makes Electron start as plain Node and fail on
// the first line of main.js. Cleared here so the app starts the same from any
// terminal, on any OS.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import electron from "electron";

const repo = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const devIndex = args.indexOf("--dev");
if (devIndex !== -1) {
  args.splice(devIndex, 1);
  const dev = path.join(repo, ".dev");
  // Its own Chromium profile too, which is also what keeps it from being
  // treated as a second copy of the installed app (the single-instance lock
  // lives in the profile).
  env.FLIGHT_RECORDER_USER_DATA_DIR = path.join(dev, "profile");
  env.FLIGHT_RECORDER_VIDEOS_DIR = path.join(dev, "Videos");
  seedDevLibrary(path.join(dev, "Videos", "flight-recorder"));
}

const child = spawn(electron, [repo, ...args], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Enough questions in each category to try reordering, scrolling and
// selecting properly. Only written when the dev library doesn't exist yet;
// delete .dev/ to start over.
function seedDevLibrary(libraryDir) {
  const file = path.join(libraryDir, "library.json");
  if (fs.existsSync(file)) return;
  const samples = {
    Behavioural: [
      "Tell me about yourself.",
      "Tell me about a time you disagreed with a teammate.",
      "Describe a project you're proud of.",
      "Tell me about a time you failed.",
      "How do you handle competing deadlines?",
      "Why do you want to work here?",
    ],
    Technical: [
      "Walk me through how you'd design a URL shortener.",
      "Explain the difference between a process and a thread.",
      "How would you debug a slow database query?",
    ],
    Case: ["How many coffee shops are there in London?", "Should our client enter the electric scooter market?"],
  };
  const questions = Object.entries(samples).flatMap(([category, texts]) =>
    texts.map((text, i) => ({
      id: `dev-${category.toLowerCase()}-${i + 1}-0000-0000-000000000000`,
      category,
      text,
      createdAt: new Date(2026, 0, 1 + i).toISOString(),
      prepNotes: "",
    }))
  );
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ questions, attempts: [] }, null, 2)}\n`);
  console.log(`Seeded a dev library at ${path.relative(repo, libraryDir)} with ${questions.length} sample questions.`);
}
