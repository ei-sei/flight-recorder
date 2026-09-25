// Local speech-to-text. The model lives in the old Tauri app-data folder so a
// copy downloaded before the move to Electron is reused.

import fs from "node:fs/promises";
import path from "node:path";

export const MODEL_FILENAME = "ggml-base.en-q5_1.bin";

export function createWhisper({ modelDir }) {
  const modelPath = path.join(modelDir, MODEL_FILENAME);

  return {
    modelPath,

    // Asked of the filesystem every time - see the note in store.js about why
    // this is never a stored flag.
    async modelPresent() {
      try {
        await fs.access(modelPath);
        return true;
      } catch {
        return false;
      }
    },

    async downloadModel() {
      throw new Error("Downloading the speech model isn't available in this build yet.");
    },

    async transcribe() {
      throw new Error("Speech-to-text isn't available in this build yet.");
    },
  };
}
