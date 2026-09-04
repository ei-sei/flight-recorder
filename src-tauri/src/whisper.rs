use tauri::AppHandle;

// Emitted repeatedly while the model downloads. `total` is None when the
// server doesn't send Content-Length - the frontend shows an indeterminate
// bar rather than inventing a percentage it can't back up.
#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

const DOWNLOAD_PROGRESS_EVENT: &str = "whisper-download-progress";

// One chunk of transcribed speech with the times it covers. Note these are
// whisper's own decoding chunks, not sentences - it splits on its decoding
// windows, so don't read sentence structure into the boundaries. Times are
// milliseconds from the start of the recording.
#[derive(serde::Serialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

// Carries how long transcription took alongside the result. Tuning this path
// without a number to compare against is guesswork, and guesswork is how a
// 4 minute recording came to take 5 minutes without anyone noticing. The
// frontend logs it to the console rather than showing it - it is a
// diagnostic, not a metric about the user's speech.
#[derive(serde::Serialize)]
pub struct TranscriptionResult {
    pub segments: Vec<TranscriptSegment>,
    pub audio_ms: u64,
    pub elapsed_ms: u64,
}

const MODEL_FILENAME: &str = "ggml-base.en-q5_1.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin";
const WHISPER_SAMPLE_RATE: u32 = 16_000;

// ureq applies no timeouts of its own, so these are the only thing standing
// between a stalled connection and a download that hangs forever behind a
// progress dialog with no cancel button. The read timeout is per-read, not
// for the whole transfer, so it can stay generous without capping how long a
// slow connection is allowed to take overall.
const MODEL_CONNECT_TIMEOUT_SECS: u64 = 15;
const MODEL_READ_TIMEOUT_SECS: u64 = 60;
const DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;
// Emitting on every chunk would be hundreds of IPC messages a second on a
// fast connection, for a bar that only needs to visibly move a few times a
// second.
const PROGRESS_EMIT_INTERVAL_MS: u128 = 100;

mod backend {
    use super::{
        DownloadProgress, TranscriptSegment, DOWNLOAD_CHUNK_BYTES, DOWNLOAD_PROGRESS_EVENT,
        MODEL_CONNECT_TIMEOUT_SECS, MODEL_FILENAME, MODEL_READ_TIMEOUT_SECS, MODEL_URL,
        PROGRESS_EMIT_INTERVAL_MS, WHISPER_SAMPLE_RATE,
    };
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    // fs:scope in capabilities/default.json bounds the fs plugin, but it has
    // no say over a custom command, which opens whatever path the frontend
    // hands it. The same bound is applied here rather than assumed, so the
    // relative-path discipline that keeps the library folder portable is also
    // what keeps this command from reading outside it.
    pub fn resolve_recording_path(app: &AppHandle, video_path: &str) -> Result<PathBuf, String> {
        let library = app
            .path()
            .video_dir()
            .map_err(|e| e.to_string())?
            .join("flight-recorder");
        // Canonicalised on both sides, so a path containing ".." is compared
        // by where it actually lands rather than by how it is spelled.
        let library = std::fs::canonicalize(&library).map_err(|e| e.to_string())?;
        let requested = std::fs::canonicalize(video_path).map_err(|e| e.to_string())?;
        if !requested.starts_with(&library) {
            return Err("recording is outside the library folder".into());
        }
        Ok(requested)
    }

    fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join(MODEL_FILENAME))
    }

    // Whether the model is actually on this device, asked of the filesystem
    // rather than of a stored boolean.
    //
    // The two used to disagree, and the disagreement mattered: the model lives
    // in the OS app-data directory, while the flag recording "it's downloaded"
    // lived in library.json inside Videos/flight-recorder. Removing app data
    // deleted the model and left the flag saying otherwise, so the frontend
    // skipped its confirmation dialog and the next recording quietly pulled
    // 60MB down. This app promises the download only ever happens after the
    // user agrees to it, so the answer has to come from the file itself.
    pub fn model_if_present(app: &AppHandle) -> Result<Option<PathBuf>, String> {
        let path = model_path(app)?;
        if path.exists() {
            Ok(Some(path))
        } else {
            Ok(None)
        }
    }

    pub fn ensure_model_downloaded(app: &AppHandle) -> Result<PathBuf, String> {
        let path = model_path(app)?;
        if path.exists() {
            return Ok(path);
        }

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(MODEL_CONNECT_TIMEOUT_SECS))
            .timeout_read(Duration::from_secs(MODEL_READ_TIMEOUT_SECS))
            .build();
        let response = agent.get(MODEL_URL).call().map_err(|e| e.to_string())?;
        // Absent on a server that doesn't send it - the frontend falls back
        // to an indeterminate bar rather than a fabricated percentage.
        let total: Option<u64> = response
            .header("Content-Length")
            .and_then(|v| v.parse().ok());

        let tmp_path = path.with_extension("bin.part");
        let downloaded = match stream_to_file(app, response, &tmp_path, total) {
            Ok(downloaded) => downloaded,
            Err(err) => {
                // Otherwise a failed download leaves ~60MB of app-data behind
                // that nothing will ever read, since the retry starts over.
                let _ = std::fs::remove_file(&tmp_path);
                return Err(err);
            }
        };

        // Checked before the rename, because the rename is what makes the file
        // real. A truncated body promoted to the final name becomes a
        // permanently broken model: path.exists() treats it as valid from then
        // on, every transcription fails with an opaque whisper error, and
        // nothing in the UI can recover from it.
        if let Some(expected) = total {
            if downloaded != expected {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(format!(
                    "speech model download was incomplete: got {downloaded} bytes, expected {expected}"
                ));
            }
        }

        std::fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
        Ok(path)
    }

    // Split out of ensure_model_downloaded so every failure inside it lands on
    // one cleanup path rather than leaving a half-written .part behind.
    fn stream_to_file(
        app: &AppHandle,
        response: ureq::Response,
        tmp_path: &Path,
        total: Option<u64>,
    ) -> Result<u64, String> {
        let mut reader = response.into_reader();
        let mut file = std::fs::File::create(tmp_path).map_err(|e| e.to_string())?;
        let mut buf = [0u8; DOWNLOAD_CHUNK_BYTES];
        let mut downloaded: u64 = 0;
        let mut last_emit = Instant::now();
        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            downloaded += n as u64;
            if last_emit.elapsed().as_millis() >= PROGRESS_EMIT_INTERVAL_MS {
                let _ = app.emit(
                    DOWNLOAD_PROGRESS_EVENT,
                    DownloadProgress { downloaded, total },
                );
                last_emit = Instant::now();
            }
        }
        // Flushed explicitly so a write error surfaces here, on the path that
        // cleans up, rather than silently at drop after the size check passed.
        file.flush().map_err(|e| e.to_string())?;
        // One last emit so the bar actually reaches its true final value
        // even if the last chunk landed inside the throttle window.
        let _ = app.emit(
            DOWNLOAD_PROGRESS_EVENT,
            DownloadProgress { downloaded, total },
        );
        Ok(downloaded)
    }

    // Reads the 16kHz mono f32 PCM the frontend extracted, and deletes it.
    //
    // This used to demux and decode the recording itself, with symphonia and
    // rubato. That could not work on Windows: WebView2 is Chromium, and
    // Chromium's MP4 muxer writes an esds box with no SLConfigDescriptor,
    // which symphonia's isomp4 reader treats as mandatory and hard-errors on
    // ("isomp4: missing sl config descriptor"). Every Windows recording failed
    // there, and because a failed transcription used to render as "No speech
    // detected in this recording", nobody could tell. WebM/Opus recordings
    // failed too, for the separate reason that symphonia has no Opus decoder.
    //
    // The webview can always decode the file it just produced, so the decode
    // moved there (see extractPcmForTranscription in attempts.js) and this
    // side just reads the result. That removes the container question from
    // this code path entirely rather than fixing it one format at a time.
    //
    // The file is raw little-endian f32 with no header. Both ends are in this
    // repo and it lives for a few seconds, so a self-describing container
    // would only be describing the format to us.
    pub fn read_pcm_and_delete(pcm_path: &Path) -> Result<Vec<f32>, String> {
        let bytes = std::fs::read(pcm_path).map_err(|e| e.to_string())?;
        // Deleted as soon as it is read, not after transcription, so a whisper
        // failure can't leave a large scratch file behind. It is ~19MB for ten
        // minutes and nothing else ever looks at it.
        let _ = std::fs::remove_file(pcm_path);

        if bytes.is_empty() {
            return Err("recording produced no decodable audio".into());
        }
        if bytes.len() % 4 != 0 {
            return Err(format!(
                "PCM file is {} bytes, which is not a whole number of f32 samples",
                bytes.len()
            ));
        }

        let samples: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();

        // A recording shorter than this is not something whisper can say
        // anything useful about, and an all-zero buffer means the extraction
        // silently produced nothing.
        if samples.len() < WHISPER_SAMPLE_RATE as usize / 10 {
            return Err("recording produced no decodable audio".into());
        }
        Ok(samples)
    }

    // The loaded model, kept alive between transcriptions. Building a
    // WhisperContext reads and parses the whole ~60MB file, and doing that
    // again for every recording is pure waste when the path never changes.
    // Keyed on the path anyway, so a future model swap can't be served a
    // stale context. Transcriptions are already serialised on the frontend
    // (see transcriptionQueue in attempts.js), so holding this lock for the
    // duration of a run costs nothing.
    struct CachedModel {
        path: PathBuf,
        ctx: WhisperContext,
    }

    static MODEL_CACHE: OnceLock<Mutex<Option<CachedModel>>> = OnceLock::new();

    pub fn run_transcription(
        model_path: &Path,
        pcm: Vec<f32>,
    ) -> Result<(Vec<TranscriptSegment>, u64), String> {
        let cache = MODEL_CACHE.get_or_init(|| Mutex::new(None));
        // A poisoned lock means a previous run panicked inside whisper. The
        // context itself is still fine to reuse, so recover rather than
        // failing every subsequent transcription for the life of the process.
        let mut cached = cache.lock().unwrap_or_else(|e| e.into_inner());

        if cached.as_ref().map(|m| m.path.as_path()) != Some(model_path) {
            let path_str = model_path.to_str().ok_or("invalid model path")?;
            let ctx =
                WhisperContext::new_with_params(path_str, WhisperContextParameters::default())
                    .map_err(|e| e.to_string())?;
            *cached = Some(CachedModel {
                path: model_path.to_path_buf(),
                ctx,
            });
        }
        let ctx = &cached.as_ref().expect("populated directly above").ctx;
        let mut state = ctx.create_state().map_err(|e| e.to_string())?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // whisper.cpp defaults to 4 threads regardless of the machine, which
        // leaves most of an 8-core laptop idle on the slowest operation in the
        // app and oversubscribes a 2-core one. Capped at 8 because ggml sees
        // little past that, and this runs in the background while the user is
        // still using the app.
        params.set_n_threads(
            std::thread::available_parallelism()
                .map(|n| n.get().min(8) as i32)
                .unwrap_or(4),
        );
        params.set_language(Some("en"));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        // Keeps whisper from emitting "[BLANK_AUDIO]", music glyphs and the
        // like as if they were spoken words - they'd be counted towards the
        // word total and drag WPM around. Doesn't stop it inventing real-
        // looking sentences over silence; the caller cross-checks segment
        // times against measured mic activity for that.
        params.set_suppress_nst(true);
        // Temperature fallback stays ON (whisper's default 0.2, so up to six
        // passes). It was briefly disabled for speed, which worked - and cost
        // noticeably more than it bought.
        //
        // Those retries are precisely what rescues a passage the decoder is
        // struggling with, and this app deliberately makes the audio harder:
        // capture no longer applies noise suppression or auto gain control,
        // because faithful recordings matter more than convenient ones. Taking
        // away the safety net at the same moment as roughening the input was
        // the wrong pair of changes to combine, and transcripts got worse.
        //
        // If transcription needs to be faster again, take it from somewhere
        // that isn't accuracy: the model context is already cached, and the
        // elapsed time is now logged so the next attempt can be measured
        // rather than guessed at.

        let started = Instant::now();
        state.full(params, &pcm).map_err(|e| e.to_string())?;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let num_segments = state.full_n_segments().map_err(|e| e.to_string())?;
        let mut segments = Vec::with_capacity(num_segments as usize);
        for i in 0..num_segments {
            let text = state.full_get_segment_text(i).map_err(|e| e.to_string())?;
            if text.trim().is_empty() {
                continue;
            }
            // whisper reports these in centiseconds.
            segments.push(TranscriptSegment {
                text,
                start_ms: state.full_get_segment_t0(i).map_err(|e| e.to_string())? * 10,
                end_ms: state.full_get_segment_t1(i).map_err(|e| e.to_string())? * 10,
            });
        }
        Ok((segments, elapsed_ms))
    }
}

// Asked before offering the download, so the offer is based on what is on
// disk now rather than on what was true when the setting was last changed.
#[tauri::command]
pub async fn whisper_model_present(app: AppHandle) -> Result<bool, String> {
    Ok(backend::model_if_present(&app)?.is_some())
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || backend::ensure_model_downloaded(&app))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

// Takes the path of a PCM file the frontend extracted from the recording, not
// the recording itself - see read_pcm_and_delete for why the decode lives on
// that side now. Still bounded to the library folder: the scratch file is
// written next to the video it came from.
#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    pcm_path: String,
) -> Result<TranscriptionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pcm_file = backend::resolve_recording_path(&app, &pcm_path)?;
        // Checked before reading the PCM, so a missing model doesn't consume
        // the scratch file and leave nothing to retry with.
        //
        // Deliberately does NOT download. This used to call
        // ensure_model_downloaded, which meant a recording could trigger a
        // 60MB fetch on its own if the model had gone missing - no dialog, no
        // mention, on a device where the user had never agreed to it. The
        // download now only ever happens from download_whisper_model, which is
        // the command behind the confirmation prompt.
        let model = backend::model_if_present(&app)?
            .ok_or("the speech model isn't on this device - turn Speech pace (WPM) off and on again in Settings to download it")?;
        let pcm = backend::read_pcm_and_delete(&pcm_file)?;
        let audio_ms = (pcm.len() as u64 * 1000) / WHISPER_SAMPLE_RATE as u64;
        let (segments, elapsed_ms) = backend::run_transcription(&model, pcm)?;
        Ok(TranscriptionResult {
            segments,
            audio_ms,
            elapsed_ms,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
