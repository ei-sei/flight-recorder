// Local speech-to-text: downloading the model (only ever from the in-app
// confirmation prompt) and running the fr-whisper helper over a recording.
//
// The helper is a separate program (native/) rather than code inside the app.
// It's the one part compiled for a specific CPU instruction set, and when
// that went wrong once, the whole app vanished the moment transcription
// started. A crash in its own process is just a failed transcription.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MODEL_FILENAME = "ggml-base.en-q5_1.bin";

// Pinned, so a truncated, corrupted or substituted download is refused before
// whisper.cpp - C++ parsing a 60MB binary - ever opens it. Values are Hugging
// Face's own LFS record for the file.
const MODEL = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
  sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
  bytes: 59_721_011,
};

const MISSING_MODEL_ERROR =
  "the speech model isn't on this device - turn Speech pace (WPM) off and on again in Settings to download it";

// Nothing else stands between a stalled connection and a progress dialog
// with no cancel button. The stall timeout restarts with every chunk, so a
// slow connection can take as long as it needs.
const CONNECT_TIMEOUT_MS = 15_000;
const STALL_TIMEOUT_MS = 60_000;
// The bar only needs to move a few times a second; a message per network
// chunk would be hundreds a second on a fast connection.
const PROGRESS_INTERVAL_MS = 100;

// Windows reports a crash as an NTSTATUS exit code rather than a signal.
const WINDOWS_ILLEGAL_INSTRUCTION = 0xc000001d;

function crashMessage(code, signal) {
  if (signal === "SIGILL" || code === WINDOWS_ILLEGAL_INSTRUCTION) {
    return "the speech engine crashed: it uses a processor instruction this computer doesn't have";
  }
  if (signal) return `the speech engine crashed (${signal})`;
  return `the speech engine stopped unexpectedly (exit code ${code})`;
}

// The helper prints one JSON object on its last line of stdout; whisper.cpp's
// own logging goes to stderr.
function lastJsonLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

// modelDir: where the model lives (the old Tauri app-data folder, so an
// existing download is reused). helperPath: the fr-whisper executable.
// library: from library.js, to confine the PCM path to the library folder.
// model: overridable for tests, which never download the real thing.
export function createWhisper({ modelDir, helperPath, library, model = MODEL }) {
  const modelPath = path.join(modelDir, MODEL_FILENAME);
  let download = null;
  let queue = Promise.resolve();
  const running = new Set();

  // Asked of the filesystem every time - see the note in store.js about why
  // this is never a stored flag.
  async function modelPresent() {
    try {
      await fsp.access(modelPath);
      return true;
    } catch {
      return false;
    }
  }

  async function fetchModel(onProgress) {
    await fsp.mkdir(modelDir, { recursive: true });
    const partPath = `${modelPath}.part`;
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error("couldn't reach the download server")), CONNECT_TIMEOUT_MS);
    const restartStallTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error("the download stalled")), STALL_TIMEOUT_MS);
    };

    try {
      const response = await fetch(model.url, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`the download failed (HTTP ${response.status})`);
      restartStallTimer();
      // Absent when the server doesn't send it - the progress bar then goes
      // indeterminate rather than showing a percentage it can't back up.
      const header = Number(response.headers.get("content-length"));
      const total = Number.isFinite(header) && header > 0 ? header : null;

      const hash = crypto.createHash("sha256");
      let downloaded = 0;
      let lastProgress = 0;
      const tally = new Transform({
        transform(chunk, _encoding, callback) {
          restartStallTimer();
          hash.update(chunk);
          downloaded += chunk.length;
          const now = Date.now();
          if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
            lastProgress = now;
            onProgress?.({ downloaded, total });
          }
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), tally, fs.createWriteStream(partPath), {
        signal: controller.signal,
      });
      // Once more at the end, so the bar reaches its true final value.
      onProgress?.({ downloaded, total });

      // Checked before the rename, because the rename is what makes the file
      // count as present from then on.
      if (total !== null && downloaded !== total) {
        throw new Error(`speech model download was incomplete: got ${downloaded} bytes, expected ${total}`);
      }
      if (downloaded !== model.bytes || hash.digest("hex") !== model.sha256) {
        throw new Error("the downloaded speech model wasn't the expected file - try again");
      }
      await fsp.rename(partPath, modelPath);
    } catch (err) {
      // A failed download would otherwise leave up to 60MB behind that
      // nothing reads, since the retry starts over.
      await fsp.rm(partPath, { force: true });
      throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : err;
    } finally {
      clearTimeout(timer);
    }
  }

  // The only place the model is ever fetched. transcribe() never downloads -
  // a recording must not pull 60MB on its own on a device where nobody agreed
  // to it.
  function downloadModel(onProgress) {
    download ??= (async () => {
      if (!(await modelPresent())) await fetchModel(onProgress);
    })().finally(() => {
      download = null;
    });
    return download;
  }

  function runHelper(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(helperPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      running.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      // Kept to the tail: it's only there to explain a failure.
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-16_384);
      });
      child.on("error", (err) => {
        running.delete(child);
        reject(err.code === "ENOENT" ? new Error("the speech engine is missing from this installation") : err);
      });
      child.on("close", (code, signal) => {
        running.delete(child);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  async function transcribeNow(pcmPath) {
    const pcm = await library.inside(pcmPath);
    try {
      if (path.extname(pcm) !== ".pcm") throw new Error("not a transcription audio file");
      if (!(await modelPresent())) throw new Error(MISSING_MODEL_ERROR);
      const { code, signal, stdout, stderr } = await runHelper(["transcribe", "--model", modelPath, "--pcm", pcm]);
      const reply = lastJsonLine(stdout);
      if (reply?.ok) {
        const { ok: _ok, ...result } = reply;
        return result;
      }
      if (stderr) console.error(`fr-whisper output:\n${stderr}`);
      throw new Error(reply?.error ?? crashMessage(code, signal));
    } finally {
      // The helper deletes it as soon as it has read it; this covers every
      // way of failing before that. ~19MB for ten minutes of audio, in the
      // user's own Videos folder.
      await fsp.rm(pcm, { force: true });
    }
  }

  return {
    modelPath,
    modelPresent,
    downloadModel,

    // Resolves to the helper's result: { segments, audio_ms, elapsed_ms,
    // threads, system_info }. One at a time - each run saturates the CPU,
    // and two at once is slower than two in turn.
    transcribe(pcmPath) {
      const job = queue.then(() => transcribeNow(pcmPath));
      queue = job.catch(() => {});
      return job;
    },

    async version() {
      try {
        const { stdout } = await runHelper(["--version"]);
        return lastJsonLine(stdout)?.version ?? "unknown";
      } catch {
        return "missing";
      }
    },

    // Called on quit, so a transcription in progress doesn't outlive the app.
    stop() {
      for (const child of running) child.kill();
    },
  };
}
