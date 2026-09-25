// whisper.cpp, run over the 16kHz mono PCM the app extracted from a
// recording. Carried over from the Tauri build's whisper.rs unchanged apart
// from what the move to a separate program made unnecessary: the model is no
// longer cached between runs (each run is its own process), and nothing here
// knows about the app's folders - main.rs is handed the paths.

use std::path::Path;
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

// One chunk of transcribed speech with the times it covers. Note these are
// whisper's own decoding chunks, not sentences - it splits on its decoding
// windows, so don't read sentence structure into the boundaries. Times are
// milliseconds from the start of the recording.
#[derive(serde::Serialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    // Present so the frontend can detect a gap between any two consecutive
    // words and mark it, independent of where whisper happened to draw its
    // segment boundaries - those are ~30s decode windows, not sentences or
    // pauses, so a real gap in the middle of one would otherwise be invisible.
    pub words: Vec<Word>,
}

#[derive(serde::Serialize)]
pub struct Word {
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
    // What the shipped binary can actually use, and how hard it was allowed to
    // work. Both are properties of the build and the machine, not of anything
    // decided here, and neither is discoverable any other way: ggml's SIMD
    // support is fixed at compile time by whichever runner built the release,
    // so the only honest way to know whether a given install has AVX2 is to
    // ask it. Transcription being several times slower than the hardware
    // suggests is exactly the question this answers.
    pub threads: i32,
    pub system_info: String,
}

// Reads the 16kHz mono f32 PCM the frontend extracted, and deletes it.
//
// The decode happens in the app's renderer, not here. It used to demux and
// decode the recording itself, with symphonia and rubato, and that could not
// work on Windows: Chromium's MP4 muxer writes an esds box with no
// SLConfigDescriptor, which symphonia's isomp4 reader treats as mandatory
// and hard-errors on ("isomp4: missing sl config descriptor"). Every Windows
// recording failed there, and because a failed transcription used to render
// as "No speech detected in this recording", nobody could tell. WebM/Opus
// recordings failed too, for the separate reason that symphonia has no Opus
// decoder.
//
// The renderer can always decode the file it just produced, so the decode
// lives there (see extractPcmForTranscription in attempts.js) and this side
// just reads the result. That removes the container question from this code
// path entirely rather than fixing it one format at a time.
//
// The file is raw little-endian f32 with no header. Both ends are in this
// repo and it lives for a few seconds, so a self-describing container would
// only be describing the format to us.
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

// whisper.cpp defaults to 4 threads regardless of the machine, which leaves
// most of an 8-core box idle on the slowest operation in the app and
// oversubscribes a 2-core one. Capped at 8 because ggml sees little past
// that, and this runs in the background while the user is still using the
// app.
//
// available_parallelism reports LOGICAL processors, so a 4-core machine with
// hyperthreading asks for 8 threads over 4 physical cores. Whether that helps
// or hurts ggml is worth measuring rather than assuming, which is why the
// figure is reported back with the timing.
pub fn transcription_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(4)
}

// Loads the model fresh each run. The Tauri build kept it loaded between
// recordings; as a separate program that would mean a process left running
// in the background, and loading the ~60MB file costs a fraction of a second
// against transcription measured in seconds.
pub fn run_transcription(
    model_path: &Path,
    pcm: &[f32],
) -> Result<(Vec<TranscriptSegment>, u64), String> {
    let path_str = model_path.to_str().ok_or("invalid model path")?;
    let ctx = WhisperContext::new_with_params(path_str, WhisperContextParameters::default())
        .map_err(|e| e.to_string())?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(transcription_threads());
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    // Keeps whisper from emitting "[BLANK_AUDIO]", music glyphs and the like
    // as if they were spoken words - they'd be counted towards the word total
    // and drag WPM around. Doesn't stop it inventing real-looking sentences
    // over silence; the caller cross-checks segment times against measured
    // mic activity for that.
    params.set_suppress_nst(true);
    // Per-token timing, so words can be reconstructed with start/end times -
    // see words_in_segment. This is whisper's plain per-token estimate (signal
    // energy plus the decoder's own timestamp tokens), not the experimental
    // DTW alignment: DTW needs a per-model attention-head preset and a
    // dedicated 128MB buffer for a more precise result this doesn't need -
    // placing an ellipsis at a multi-hundred-millisecond gap doesn't need
    // frame-accurate boundaries.
    params.set_token_timestamps(true);
    // Temperature fallback stays ON (whisper's default 0.2, so up to six
    // passes). It was briefly disabled for speed, which worked - and cost
    // noticeably more than it bought.
    //
    // Those retries are precisely what rescues a passage the decoder is
    // struggling with, and this app deliberately makes the audio harder:
    // capture no longer applies noise suppression or auto gain control,
    // because faithful recordings matter more than convenient ones. Taking
    // away the safety net at the same moment as roughening the input was the
    // wrong pair of changes to combine, and transcripts got worse.
    //
    // If transcription needs to be faster again, take it from somewhere that
    // isn't accuracy: the elapsed time is logged so the next attempt can be
    // measured rather than guessed at.

    let started = Instant::now();
    state.full(params, pcm).map_err(|e| e.to_string())?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    // Anything at or past this id is a control or timestamp token, not
    // transcript text - eot itself, language/task tokens, and the 1500
    // timestamp tokens all sit beyond it in whisper's vocabulary layout.
    let eot = ctx.token_eot();

    let num_segments = state.full_n_segments().map_err(|e| e.to_string())?;
    let mut segments = Vec::with_capacity(num_segments as usize);
    for i in 0..num_segments {
        let text = state.full_get_segment_text(i).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            continue;
        }
        let words = words_in_segment(&state, i, eot)?;
        // whisper reports these in centiseconds.
        segments.push(TranscriptSegment {
            text,
            start_ms: state.full_get_segment_t0(i).map_err(|e| e.to_string())? * 10,
            end_ms: state.full_get_segment_t1(i).map_err(|e| e.to_string())? * 10,
            words,
        });
    }
    Ok((segments, elapsed_ms))
}

// Whisper emits sub-word BPE tokens, not words - "Juniper" can arrive as
// "Jun" + "iper". Its tokenizer marks the start of a new word with a leading
// space on the token's own decoded text (the standard GPT-2/BPE convention),
// so a token that starts with one begins a new word and everything else
// continues the current one. Special and timestamp tokens (id >= eot) carry
// no transcript text and are dropped rather than merged in.
fn words_in_segment(
    state: &whisper_rs::WhisperState,
    segment: i32,
    eot: whisper_rs::WhisperToken,
) -> Result<Vec<Word>, String> {
    let n_tokens = state.full_n_tokens(segment).map_err(|e| e.to_string())?;
    let mut words: Vec<Word> = Vec::new();
    for j in 0..n_tokens {
        let id = state
            .full_get_token_id(segment, j)
            .map_err(|e| e.to_string())?;
        if id >= eot {
            continue;
        }
        let text = state
            .full_get_token_text_lossy(segment, j)
            .map_err(|e| e.to_string())?;
        if text.is_empty() {
            continue;
        }
        let data = state
            .full_get_token_data(segment, j)
            .map_err(|e| e.to_string())?;
        // whisper reports these in centiseconds, same as segment times.
        let start_ms = data.t0 * 10;
        let end_ms = data.t1 * 10;

        let starts_new_word = text.starts_with(' ') || words.is_empty();
        if starts_new_word {
            words.push(Word {
                text: text.trim_start().to_string(),
                start_ms,
                end_ms,
            });
        } else if let Some(last) = words.last_mut() {
            last.text.push_str(&text);
            last.end_ms = end_ms;
        }
    }
    Ok(words)
}
