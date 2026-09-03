use tauri::AppHandle;

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

mod backend {
    use super::{TranscriptSegment, MODEL_FILENAME, MODEL_URL, WHISPER_SAMPLE_RATE};
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };
    use std::path::{Path, PathBuf};
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as SymphoniaError;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use tauri::{AppHandle, Manager};

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

        let response = ureq::get(MODEL_URL).call().map_err(|e| e.to_string())?;
        let tmp_path = path.with_extension("bin.part");
        {
            let mut file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut response.into_reader(), &mut file).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
        Ok(path)
    }

    // Demuxes/decodes the audio track of a recorded video file (MP4/AAC is
    // the real case everywhere now; WebM/Opus is a defensive fallback - see
    // RECORDING_FORMAT_CANDIDATES in recorder.js), downmixes to mono, and
    // resamples to the 16kHz mono f32 PCM whisper.cpp expects.
    pub fn decode_audio_to_pcm16k(video_path: &str) -> Result<Vec<f32>, String> {
        let file = std::fs::File::open(video_path).map_err(|e| e.to_string())?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = Path::new(video_path).extension().and_then(|e| e.to_str()) {
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

        let mut mono_samples: Vec<f32> = Vec::new();
        let mut native_rate: Option<u32> = None;

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

            let mut sample_buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            sample_buf.copy_interleaved_ref(decoded);
            for frame in sample_buf.samples().chunks(channel_count) {
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
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
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
        let model = backend::ensure_model_downloaded(&app)?;
        let pcm = backend::decode_audio_to_pcm16k(&video_path)?;
        backend::run_transcription(&model, pcm)
    })
    .await
    .map_err(|e| e.to_string())?
}
