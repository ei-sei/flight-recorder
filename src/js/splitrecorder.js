// Works around WebKitGTK's MediaRecorder losing all video when it records
// audio and video together (see mp4merge.js and CLAUDE.md for the diagnosis):
// records each track with its own MediaRecorder and merges the two files.
//
// Whether that's needed is measured, not assumed from the platform. A hidden
// one-second test recording at startup checks whether the engine keeps video
// alongside audio. If it does - Windows, macOS, or a WebKitGTK that has since
// fixed the bug - the app records normally and none of this is used. So the
// workaround retires itself on its own once WebKit is fixed, with no update.

import { countSamples, mergeAudioVideo } from "./mp4merge.js";

// The merge only understands MP4, so both halves must be MP4.
const VIDEO_ONLY_TYPES = [
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.4D401F",
  "video/mp4;codecs=avc1.42E01F",
  "video/mp4",
];
const AUDIO_ONLY_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"];

const PROBE_MS = 1000;
const PROBE_AUDIO_TIMEOUT_MS = 1000;

// The engine the bug is known in. Only used when the probe can't reach a
// verdict, so an inconclusive probe never changes anything on Windows/macOS.
export function isWebKitGtk() {
  const ua = navigator.userAgent;
  return /Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

function constructFirst(stream, mimeTypes, options) {
  for (const mimeType of mimeTypes) {
    try {
      return new MediaRecorder(stream, { ...options, mimeType });
    } catch (err) {
      // NotSupportedError - try the next one.
    }
  }
  throw new Error(`no supported format among ${mimeTypes.join(", ")}`);
}

// Records a second of a changing canvas plus silence, as one combined MP4, and
// checks the result for video. Returns { mode: "combined" | "split",
// conclusive, reason }.
//
// Inconclusive when the test can't produce audio at all - an AudioContext
// still suspended by autoplay rules, say - because then a video-only result
// would say nothing about the bug. The caller can try again later.
export async function probeRecordingMode(combinedMimeTypes) {
  const fallback = (reason) => ({ mode: isWebKitGtk() ? "split" : "combined", conclusive: false, reason });
  if (typeof MediaRecorder === "undefined") return { mode: "combined", conclusive: true, reason: "no MediaRecorder" };

  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  let frame = 0;
  const drawTimer = setInterval(() => {
    ctx.fillStyle = `hsl(${(frame++ * 40) % 360}, 60%, 50%)`;
    ctx.fillRect(0, 0, 32, 32);
  }, 1000 / 24);
  let audioCtx = null;
  const tracks = [];
  try {
    audioCtx = new AudioContext();
    await Promise.race([audioCtx.resume(), new Promise((r) => setTimeout(r, PROBE_AUDIO_TIMEOUT_MS))]);
    if (audioCtx.state !== "running") return fallback("audio context not running yet");
    // Silence: offset 0. It still encodes as real audio samples.
    const source = new ConstantSourceNode(audioCtx, { offset: 0 });
    const destination = audioCtx.createMediaStreamDestination();
    source.connect(destination);
    source.start();
    tracks.push(canvas.captureStream(24).getVideoTracks()[0], destination.stream.getAudioTracks()[0]);

    const mp4Types = combinedMimeTypes.filter((m) => m.startsWith("video/mp4"));
    let recorder;
    try {
      recorder = constructFirst(new MediaStream(tracks), mp4Types, { videoBitsPerSecond: 200_000 });
    } catch (err) {
      // No combined MP4 at all - the engine will record WebM, which the merge
      // can't handle, so splitting isn't an option either way.
      return { mode: "combined", conclusive: true, reason: "no MP4 recording support" };
    }
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    await new Promise((r) => setTimeout(r, PROBE_MS));
    recorder.stop();
    await stopped;

    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    // An empty file is the bug too - it's what WebKitGTK produces when the
    // audio is a raw microphone track.
    if (bytes.length === 0) return { mode: "split", conclusive: true, reason: "combined recording came out empty" };
    const counts = countSamples(bytes);
    if (counts.audio === 0) return fallback("test recording had no audio");
    if (counts.video === 0) return { mode: "split", conclusive: true, reason: "combined recording dropped the video" };
    return { mode: "combined", conclusive: true, reason: `combined recording kept both tracks (${counts.video} video, ${counts.audio} audio samples)` };
  } catch (err) {
    return fallback(`probe failed: ${err?.message ?? err}`);
  } finally {
    clearInterval(drawTimer);
    for (const track of tracks) track.stop();
    audioCtx?.close();
  }
}

// Stands in for a MediaRecorder: the same state, mimeType, start(), stop(),
// ondataavailable and onstop that recorder.js uses, so nothing there needs to
// know which kind it has. Underneath it runs one recorder per track, and on
// stop delivers a single merged MP4 through ondataavailable, then onstop -
// the same order a real MediaRecorder uses.
//
// Throws from the constructor if either half can't record MP4, so the caller
// can fall back to a normal recorder.
export class SplitRecorder {
  constructor(stream, { videoBitsPerSecond, audioBitsPerSecond } = {}) {
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    if (!videoTrack || !audioTrack) throw new Error("SplitRecorder needs one video and one audio track");
    this.videoRecorder = constructFirst(new MediaStream([videoTrack]), VIDEO_ONLY_TYPES, { videoBitsPerSecond });
    this.audioRecorder = constructFirst(new MediaStream([audioTrack]), AUDIO_ONLY_TYPES, { audioBitsPerSecond });
    this.state = "inactive";
    this.mimeType = "video/mp4";
    this.ondataavailable = null;
    this.onstop = null;
  }

  start() {
    const collect = (recorder) => {
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      return { chunks, stopped: new Promise((resolve) => (recorder.onstop = resolve)) };
    };
    this.video = collect(this.videoRecorder);
    this.audio = collect(this.audioRecorder);
    // Back to back in the same task, so both pipelines start as close to
    // together as the engine allows.
    this.videoRecorder.start();
    this.audioRecorder.start();
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") return;
    // Like MediaRecorder: inactive immediately, data and stop events later.
    this.state = "inactive";
    this.videoRecorder.stop();
    this.audioRecorder.stop();
    this.finish();
  }

  async finish() {
    await Promise.all([this.video.stopped, this.audio.stopped]);
    const videoBlob = new Blob(this.video.chunks);
    const audioBlob = new Blob(this.audio.chunks);
    let data;
    try {
      const [videoBytes, audioBytes] = await Promise.all([videoBlob.arrayBuffer(), audioBlob.arrayBuffer()]);
      const parts = mergeAudioVideo(new Uint8Array(videoBytes), new Uint8Array(audioBytes));
      data = new Blob(parts, { type: "video/mp4" });
    } catch (err) {
      // Audio over video, if only one can be kept: this app is for reviewing
      // your delivery, and the transcript, pauses and pace all come from the
      // sound. A missing picture is visible in review; lost audio would also
      // silently cost the attempt its transcript.
      console.error("Couldn't merge the separate audio and video recordings - keeping the audio only", err);
      data = audioBlob.size > 0 ? audioBlob : videoBlob;
    }
    this.ondataavailable?.({ data });
    this.onstop?.();
  }
}
