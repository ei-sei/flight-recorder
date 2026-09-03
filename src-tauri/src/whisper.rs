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
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use symphonia::core::audio::{SampleBuffer, SignalSpec};
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as SymphoniaError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use tauri::{AppHandle, Emitter, Manager};

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

    // Demuxes/decodes the audio track of a recorded video file, downmixes to
    // mono, and resamples to the 16kHz mono f32 PCM whisper.cpp expects.
    //
    // MP4/AAC only, which is what RECORDING_FORMAT_CANDIDATES in recorder.js
    // produces everywhere it can. This used to claim WebM/Opus worked as a
    // fallback; it does not, and never did - symphonia 0.5 has no Opus
    // decoder at all, so a WebM recording reached here only to fail. The
    // frontend now recognises that format and declines to start rather than
    // handing it over (see isTranscribableFormat).
    pub fn decode_audio_to_pcm16k(video_path: &Path) -> Result<Vec<f32>, String> {
        let file = std::fs::File::open(video_path).map_err(|e| e.to_string())?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = video_path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|e| e.to_string())?;
        let mut format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("recording has no audio track")?;
        let track_id = track.id;
        let mut decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| e.to_string())?;

        // Pre-sized where the container reports a frame count, which avoids
        // roughly twenty-five grow-and-copy cycles on a ten minute recording.
        let mut mono_samples: Vec<f32> =
            Vec::with_capacity(track.codec_params.n_frames.unwrap_or(0) as usize);
        let mut native_rate: Option<u32> = None;
        // Reused across packets rather than reallocated per packet. See the
        // comment at the allocation below.
        let mut sample_buf: Option<SampleBuffer<f32>> = None;
        let mut sample_buf_shape: Option<(u64, SignalSpec)> = None;

        loop {
            let packet = match format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(err))
                    if err.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break
                }
                Err(SymphoniaError::ResetRequired) => break,
                Err(err) => return Err(err.to_string()),
            };
            if packet.track_id() != track_id {
                continue;
            }

            let decoded = match decoder.decode(&packet) {
                Ok(decoded) => decoded,
                // Corrupt/unsupported individual packets are skipped rather
                // than failing the whole transcription over one bad frame.
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(err) => return Err(err.to_string()),
            };

            let spec = *decoded.spec();
            native_rate.get_or_insert(spec.rate);
            let channel_count = spec.channels.count().max(1);

            // This used to allocate a fresh buffer on every packet, which is
            // around 28,000 allocations for a ten minute AAC recording. The
            // buffer is reused instead, and only replaced if a later packet
            // needs more room or changes format - copy_interleaved_ref panics
            // on a buffer that is too small, so this can't just assume the
            // first packet's shape holds for the rest of the stream.
            let capacity = decoded.capacity() as u64;
            let outgrown = match sample_buf_shape {
                Some((frames, buf_spec)) => capacity > frames || buf_spec != spec,
                None => true,
            };
            if outgrown {
                sample_buf = Some(SampleBuffer::<f32>::new(capacity, spec));
                sample_buf_shape = Some((capacity, spec));
            }

            let buf = sample_buf.as_mut().expect("allocated above");
            buf.copy_interleaved_ref(decoded);
            for frame in buf.samples().chunks(channel_count) {
                let sum: f32 = frame.iter().sum();
                mono_samples.push(sum / channel_count as f32);
            }
        }

        let native_rate = native_rate.ok_or("recording produced no decodable audio")?;
        if mono_samples.is_empty() {
            return Err("recording produced no decodable audio".into());
        }
        if native_rate == WHISPER_SAMPLE_RATE {
            return Ok(mono_samples);
        }
        resample_to_16k(mono_samples, native_rate)
    }

    fn resample_to_16k(samples: Vec<f32>, native_rate: u32) -> Result<Vec<f32>, String> {
        // Tuned for the consumer, which is a 16kHz speech model, not a
        // mastering chain. sinc_len is the per-output-sample cost, so the
        // original 256 spent roughly 2.5 billion multiply-adds on a ten
        // minute recording buying precision whisper cannot act on. 64 with
        // 32x oversampling is still well past transparent at this rate.
        let params = SincInterpolationParameters {
            sinc_len: 64,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 32,
            window: WindowFunction::BlackmanHarris2,
        };
        let mut resampler = SincFixedIn::<f32>::new(
            WHISPER_SAMPLE_RATE as f64 / native_rate as f64,
            2.0,
            params,
            samples.len(),
            1,
        )
        .map_err(|e| e.to_string())?;

        let output = resampler
            .process(&[samples], None)
            .map_err(|e| e.to_string())?;
        Ok(output.into_iter().next().unwrap_or_default())
    }

    pub fn run_transcription(
        model_path: &Path,
        pcm: Vec<f32>,
    ) -> Result<Vec<TranscriptSegment>, String> {
        use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

        let model_path = model_path.to_str().ok_or("invalid model path")?;
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| e.to_string())?;
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

        state.full(params, &pcm).map_err(|e| e.to_string())?;

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
        Ok(segments)
    }
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || backend::ensure_model_downloaded(&app))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    video_path: String,
) -> Result<Vec<TranscriptSegment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recording = backend::resolve_recording_path(&app, &video_path)?;
        let model = backend::ensure_model_downloaded(&app)?;
        let pcm = backend::decode_audio_to_pcm16k(&recording)?;
        backend::run_transcription(&model, pcm)
    })
    .await
    .map_err(|e| e.to_string())?
}
