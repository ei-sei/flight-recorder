// fr-whisper: Flight Recorder's local speech-to-text, as a small program the
// app runs once per recording.
//
//   fr-whisper transcribe --model <file> --pcm <file>
//   fr-whisper --version
//
// It prints exactly one line of JSON on stdout - {"ok":true,...} or
// {"ok":false,"error":"..."} - and nothing else, since whisper.cpp's own
// logging goes to stderr and the app reads stdout. It never touches the
// network: the app downloads the model and passes its path in.
//
// Being a separate process is the point. The speech engine is the one part of
// the app compiled for a specific CPU instruction set, and when that went
// wrong (AVX-512 code shipped to CPUs without it) the whole app vanished the
// moment transcription started. Now a crash here is a failed transcription
// the app can report, not a closed window.

mod transcribe;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use transcribe::{
    read_pcm_and_delete, run_transcription, transcription_threads, TranscriptionResult,
    WHISPER_SAMPLE_RATE,
};

const USAGE: &str =
    "usage: fr-whisper transcribe --model <file> --pcm <file> | fr-whisper --version";

#[derive(serde::Serialize)]
struct Success<'a> {
    ok: bool,
    #[serde(flatten)]
    result: &'a TranscriptionResult,
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let outcome = match args.first().and_then(|a| a.to_str()) {
        Some("--version") => Ok(serde_json::json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
        })
        .to_string()),
        Some("transcribe") => parse_transcribe(&args[1..]).and_then(|(model, pcm)| {
            let result = transcribe(&model, &pcm)?;
            serde_json::to_string(&Success {
                ok: true,
                result: &result,
            })
            .map_err(|e| e.to_string())
        }),
        _ => Err(USAGE.to_string()),
    };

    match outcome {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{}", serde_json::json!({ "ok": false, "error": error }));
            ExitCode::FAILURE
        }
    }
}

// OsString rather than String, so a model or recording under a folder whose
// name isn't valid UTF-8 still arrives intact.
fn parse_transcribe(args: &[OsString]) -> Result<(PathBuf, PathBuf), String> {
    let mut model = None;
    let mut pcm = None;
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        let value = rest.next().ok_or(USAGE)?;
        match flag.to_str() {
            Some("--model") => model = Some(PathBuf::from(value)),
            Some("--pcm") => pcm = Some(PathBuf::from(value)),
            _ => return Err(USAGE.to_string()),
        }
    }
    Ok((model.ok_or(USAGE)?, pcm.ok_or(USAGE)?))
}

fn transcribe(model: &Path, pcm_file: &Path) -> Result<TranscriptionResult, String> {
    // Checked before reading the PCM, so a missing model doesn't consume the
    // scratch file.
    //
    // Deliberately does NOT download: a recording must never trigger a 60MB
    // fetch on its own, on a device where the user never agreed to it. The
    // download only ever happens from the app's confirmation prompt.
    if !model.exists() {
        return Err("the speech model isn't on this device - turn Speech pace (WPM) off and on again in Settings to download it".into());
    }
    let pcm = read_pcm_and_delete(pcm_file)?;
    let audio_ms = (pcm.len() as u64 * 1000) / WHISPER_SAMPLE_RATE as u64;
    let (segments, elapsed_ms) = run_transcription(model, &pcm)?;
    Ok(TranscriptionResult {
        segments,
        audio_ms,
        elapsed_ms,
        threads: transcription_threads(),
        system_info: whisper_rs::print_system_info().to_string(),
    })
}
