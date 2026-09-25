// Joins a video-only and an audio-only fragmented MP4 - two MediaRecorder
// outputs - into one ordinary MP4 with both tracks.
//
// This exists because WebKitGTK's MediaRecorder cannot record audio and video
// together: it stamps video frames with the system's monotonic clock (hours)
// but audio from zero, so its muxer holds every video frame waiting for audio
// to "catch up", then discards them all when recording stops. The file comes
// out audio-only, or empty. Each track records perfectly on its own, so
// splitrecorder.js records them separately and this puts them back together.
// See CLAUDE.md for the full diagnosis.
//
// Pure functions over Uint8Arrays - no DOM, no Tauri - so node --test can
// cover them directly.

const textDecoder = new TextDecoder("latin1");

function u32(b, p) {
  return ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
}

function u64(b, p) {
  return u32(b, p) * 2 ** 32 + u32(b, p + 4);
}

function i32(b, p) {
  return u32(b, p) | 0;
}

function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = textDecoder.decode(b.subarray(p + 4, p + 8));
    let header = 8;
    if (size === 1) {
      size = u64(b, p + 8);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    // A truncated or corrupt box - stop rather than read past the end.
    if (size < header || p + size > end) return;
    yield { type, start: p, body: p + header, end: p + size };
    p += size;
  }
}

function child(b, parent, type) {
  for (const box of boxes(b, parent.body, parent.end)) if (box.type === type) return box;
  return null;
}

function path(b, parent, ...types) {
  let box = parent;
  for (const type of types) {
    box = child(b, box, type);
    if (!box) return null;
  }
  return box;
}

// Sample flags: bit 16 is sample_is_non_sync_sample.
const NON_SYNC = 0x00010000;

function readTrack(b, trak) {
  const tkhd = child(b, trak, "tkhd");
  const mdhd = path(b, trak, "mdia", "mdhd");
  const hdlr = path(b, trak, "mdia", "hdlr");
  const stsd = path(b, trak, "mdia", "minf", "stbl", "stsd");
  const stsz = path(b, trak, "mdia", "minf", "stbl", "stsz");
  if (!tkhd || !mdhd || !hdlr || !stsd) throw new Error("mp4: track is missing tkhd, mdhd, hdlr or stsd");

  const tkhdV1 = b[tkhd.body] === 1;
  const mdhdV1 = b[mdhd.body] === 1;
  return {
    id: u32(b, tkhd.body + (tkhdV1 ? 20 : 12)),
    handler: textDecoder.decode(b.subarray(hdlr.body + 8, hdlr.body + 12)),
    timescale: u32(b, mdhd.body + (mdhdV1 ? 20 : 12)),
    // Packed ISO-639-2 code, copied as-is.
    language: (b[mdhd.body + (mdhdV1 ? 32 : 20)] << 8) | b[mdhd.body + (mdhdV1 ? 33 : 21)],
    // 16.16 fixed point, the last 8 bytes of tkhd.
    width: u32(b, tkhd.end - 8),
    height: u32(b, tkhd.end - 4),
    stsd: b.subarray(stsd.start, stsd.end),
    // Non-zero only in a non-fragmented file. Used for counting, not merging.
    stszCount: stsz ? u32(b, stsz.body + 8) : 0,
    samples: [],
  };
}

function trexDefaults(b, moov) {
  const defaults = new Map();
  const mvex = child(b, moov, "mvex");
  if (!mvex) return defaults;
  for (const box of boxes(b, mvex.body, mvex.end)) {
    if (box.type !== "trex") continue;
    defaults.set(u32(b, box.body + 4), {
      duration: u32(b, box.body + 12),
      size: u32(b, box.body + 16),
      flags: u32(b, box.body + 20),
    });
  }
  return defaults;
}

// Reads every track and, for fragmented files, every sample - where its bytes
// are, its duration and whether it's a sync sample.
//
// Two defences against real WebKit output, both found in actual recordings:
// - A fragment's samples are only accepted if they lie entirely inside an mdat.
//   WebKit writes the final moof twice, and the first copy's data_offset points
//   into the second copy's header, not into media data.
// - A fragment that starts before the previous one ended is dropped, so a
//   duplicated fragment can never double up samples.
export function parseMp4(bytes) {
  const b = bytes;
  const top = [...boxes(b, 0, b.length)];
  const moov = top.find((box) => box.type === "moov");
  if (!moov) throw new Error("mp4: no moov box");

  const tracks = new Map();
  for (const box of boxes(b, moov.body, moov.end)) {
    if (box.type === "trak") {
      const track = readTrack(b, box);
      tracks.set(track.id, track);
    }
  }
  const trex = trexDefaults(b, moov);
  const mdats = top.filter((box) => box.type === "mdat").map((box) => [box.body, box.end]);
  const insideMdat = (start, end) => mdats.some(([s, e]) => start >= s && end <= e);
  const nextDecodeTime = new Map();

  for (const moof of top) {
    if (moof.type !== "moof") continue;
    for (const traf of boxes(b, moof.body, moof.end)) {
      if (traf.type !== "traf") continue;
      const tfhd = child(b, traf, "tfhd");
      if (!tfhd) continue;
      const tfhdFlags = u32(b, tfhd.body) & 0xffffff;
      const trackId = u32(b, tfhd.body + 4);
      const track = tracks.get(trackId);
      if (!track) continue;
      const defaults = { ...(trex.get(trackId) ?? { duration: 0, size: 0, flags: 0 }) };
      let p = tfhd.body + 8;
      let base = moof.start;
      if (tfhdFlags & 0x01) {
        base = u64(b, p);
        p += 8;
      }
      if (tfhdFlags & 0x02) p += 4;
      if (tfhdFlags & 0x08) (defaults.duration = u32(b, p)), (p += 4);
      if (tfhdFlags & 0x10) (defaults.size = u32(b, p)), (p += 4);
      if (tfhdFlags & 0x20) (defaults.flags = u32(b, p)), (p += 4);

      const tfdt = child(b, traf, "tfdt");
      let decodeTime = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : null;

      const fragment = [];
      let dataPos = base;
      for (const trun of boxes(b, traf.body, traf.end)) {
        if (trun.type !== "trun") continue;
        const version = b[trun.body];
        const flags = u32(b, trun.body) & 0xffffff;
        const count = u32(b, trun.body + 4);
        let q = trun.body + 8;
        if (flags & 0x01) (dataPos = base + i32(b, q)), (q += 4);
        let firstFlags = null;
        if (flags & 0x04) (firstFlags = u32(b, q)), (q += 4);
        for (let i = 0; i < count; i++) {
          let duration = defaults.duration;
          let size = defaults.size;
          let sampleFlags = i === 0 && firstFlags !== null ? firstFlags : defaults.flags;
          let cto = 0;
          if (flags & 0x100) (duration = u32(b, q)), (q += 4);
          if (flags & 0x200) (size = u32(b, q)), (q += 4);
          if (flags & 0x400) (sampleFlags = u32(b, q)), (q += 4);
          if (flags & 0x800) (cto = version === 1 ? i32(b, q) : u32(b, q)), (q += 4);
          fragment.push({ offset: dataPos, size, duration, sync: !(sampleFlags & NON_SYNC), cto });
          dataPos += size;
        }
      }
      if (fragment.length === 0) continue;
      if (!fragment.every((s) => insideMdat(s.offset, s.offset + s.size))) continue;
      const expected = nextDecodeTime.get(trackId);
      if (decodeTime === null) decodeTime = expected ?? 0;
      if (expected !== undefined && decodeTime < expected) continue;
      if (track.samples.length === 0) track.firstDecodeTime = decodeTime;
      track.samples.push(...fragment);
      nextDecodeTime.set(trackId, decodeTime + fragment.reduce((sum, s) => sum + s.duration, 0));
    }
  }
  return [...tracks.values()];
}

// How many samples each kind of track holds. The recording-mode probe uses
// this to tell whether the engine kept the video alongside the audio.
export function countSamples(bytes) {
  const counts = { video: 0, audio: 0 };
  for (const track of parseMp4(bytes)) {
    const n = Math.max(track.samples.length, track.stszCount);
    if (track.handler === "vide") counts.video += n;
    else if (track.handler === "soun") counts.audio += n;
  }
  return counts;
}

// --- writing ---

function box(type, ...parts) {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let p = 8;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

function fields(...specs) {
  // specs: [bytes, value] pairs, big-endian. bytes is 1, 2, 4 or 8.
  const size = specs.reduce((sum, [n]) => sum + n, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let p = 0;
  for (const [n, value] of specs) {
    if (n === 1) view.setUint8(p, value);
    else if (n === 2) view.setUint16(p, value);
    else if (n === 4) view.setUint32(p, value >>> 0);
    else view.setBigUint64(p, BigInt(value));
    p += n;
  }
  return out;
}

function fullBox(type, version, flags, ...parts) {
  return box(type, fields([1, version], [1, flags >> 16], [2, flags & 0xffff]), ...parts);
}

const MATRIX = fields([4, 0x00010000], [4, 0], [4, 0], [4, 0], [4, 0x00010000], [4, 0], [4, 0], [4, 0], [4, 0x40000000]);
const MOVIE_TIMESCALE = 1000;

function table(type, entries, entryFields, version = 0) {
  return fullBox(type, version, 0, fields([4, entries.length]), ...entries.map((e) => fields(...entryFields(e))));
}

function runLength(values) {
  const runs = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.count++;
    else runs.push({ value, count: 1 });
  }
  return runs;
}

function trackBoxes(track, trackId, chunkOffsets, useCo64) {
  const samples = track.samples;
  const mediaDuration = samples.reduce((sum, s) => sum + s.duration, 0);
  const delayMovie = Math.round(((track.delayMs ?? 0) * MOVIE_TIMESCALE) / 1000);
  const trackDuration = Math.ceil((mediaDuration * MOVIE_TIMESCALE) / track.timescale) + delayMovie;
  const isVideo = track.handler === "vide";

  const stbl = [track.stsd];
  stbl.push(table("stts", runLength(samples.map((s) => s.duration)), (r) => [[4, r.count], [4, r.value]]));
  if (samples.some((s) => s.cto !== 0)) {
    const negative = samples.some((s) => s.cto < 0);
    stbl.push(table("ctts", runLength(samples.map((s) => s.cto)), (r) => [[4, r.count], [4, r.value]], negative ? 1 : 0));
  }
  if (isVideo && samples.some((s) => !s.sync)) {
    const syncNumbers = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
    stbl.push(table("stss", syncNumbers, (n) => [[4, n]]));
  }
  const stscEntries = [];
  track.chunks.forEach((chunk, i) => {
    const last = stscEntries[stscEntries.length - 1];
    if (!last || last.perChunk !== chunk.count) stscEntries.push({ first: i + 1, perChunk: chunk.count });
  });
  stbl.push(table("stsc", stscEntries, (e) => [[4, e.first], [4, e.perChunk], [4, 1]]));
  stbl.push(fullBox("stsz", 0, 0, fields([4, 0], [4, samples.length]), ...samples.map((s) => fields([4, s.size]))));
  stbl.push(
    useCo64
      ? table("co64", chunkOffsets, (o) => [[8, o]])
      : table("stco", chunkOffsets, (o) => [[4, o]])
  );

  const mediaHeader = isVideo
    ? fullBox("vmhd", 0, 1, fields([2, 0], [2, 0], [2, 0], [2, 0]))
    : fullBox("smhd", 0, 0, fields([2, 0], [2, 0]));
  const dinf = box("dinf", fullBox("dref", 0, 0, fields([4, 1]), fullBox("url ", 0, 1)));
  const handlerName = new TextEncoder().encode(isVideo ? "VideoHandler\0" : "SoundHandler\0");

  const parts = [
    fullBox(
      "tkhd", 0, 3,
      fields([4, 0], [4, 0], [4, trackId], [4, 0], [4, trackDuration], [4, 0], [4, 0], [2, 0], [2, 0], [2, isVideo ? 0 : 0x0100], [2, 0]),
      MATRIX,
      fields([4, isVideo ? track.width : 0], [4, isVideo ? track.height : 0])
    ),
  ];
  // An empty edit delays the whole track, so a track that started recording
  // later than the other plays back later too.
  if (delayMovie > 0) {
    parts.push(
      box("edts", fullBox("elst", 0, 0, fields([4, 2]),
        fields([4, delayMovie], [4, 0xffffffff], [2, 1], [2, 0]),
        fields([4, trackDuration - delayMovie], [4, 0], [2, 1], [2, 0])))
    );
  }
  parts.push(
    box("mdia",
      fullBox("mdhd", 0, 0, fields([4, 0], [4, 0], [4, track.timescale], [4, mediaDuration], [2, track.language], [2, 0])),
      fullBox("hdlr", 0, 0, fields([4, 0]), new TextEncoder().encode(track.handler), fields([4, 0], [4, 0], [4, 0]), handlerName),
      box("minf", mediaHeader, dinf, box("stbl", ...stbl)))
  );
  return { trak: box("trak", ...parts), trackDuration };
}

// Builds one MP4 from the given tracks, taking sample data from their source
// buffers. Returns the file as a list of parts, so a caller can hand it to a
// Blob without copying the (large) media data into one more buffer first.
//
// moov goes before mdat ("fast start") and chunks are interleaved by time, so
// the file plays from the start without a player needing to seek to the end.
export function buildMp4(tracks) {
  const chunks = [];
  tracks.forEach((track, t) => {
    // One chunk per ~half second of media, which keeps audio and video
    // interleaved closely without bloating the chunk tables.
    track.chunks = [];
    const chunkTicks = track.timescale / 2;
    let current = null;
    let time = 0;
    for (const sample of track.samples) {
      if (!current || time - current.startTicks >= chunkTicks) {
        current = { track: t, startTicks: time, start: time / track.timescale + (track.delayMs ?? 0) / 1000, samples: [], count: 0 };
        track.chunks.push(current);
        chunks.push(current);
      }
      current.samples.push(sample);
      current.count++;
      time += sample.duration;
    }
  });
  chunks.sort((a, b) => a.start - b.start || a.track - b.track);

  const ftyp = box("ftyp", new TextEncoder().encode("isom"), fields([4, 0x200]), new TextEncoder().encode("isomiso2avc1mp41"));
  const mediaBytes = chunks.reduce((sum, c) => sum + c.samples.reduce((s, x) => s + x.size, 0), 0);

  const buildMoov = (offsets, useCo64) => {
    const traks = tracks.map((track, t) => trackBoxes(track, t + 1, offsets[t], useCo64));
    const movieDuration = Math.max(0, ...traks.map((x) => x.trackDuration));
    const mvhd = fullBox(
      "mvhd", 0, 0,
      fields([4, 0], [4, 0], [4, MOVIE_TIMESCALE], [4, movieDuration], [4, 0x00010000], [2, 0x0100], [2, 0], [4, 0], [4, 0]),
      MATRIX,
      fields([4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, 0], [4, tracks.length + 1])
    );
    return box("moov", mvhd, ...traks.map((x) => x.trak));
  };

  // The chunk offsets depend on moov's size, which depends on the offset
  // table's width - so size moov once with placeholders, then fill it in.
  const placeholder = tracks.map((track) => track.chunks.map(() => 0));
  let useCo64 = false;
  let moovSize = buildMoov(placeholder, false).length;
  const bigMdat = mediaBytes + 8 > 0xffffffff;
  const mdatHeaderSize = bigMdat ? 16 : 8;
  if (ftyp.length + moovSize + mdatHeaderSize + mediaBytes > 0xffffffff) {
    useCo64 = true;
    moovSize = buildMoov(placeholder, true).length;
  }

  const offsets = tracks.map(() => []);
  let position = ftyp.length + moovSize + mdatHeaderSize;
  for (const chunk of chunks) {
    offsets[chunk.track].push(position);
    position += chunk.samples.reduce((s, x) => s + x.size, 0);
  }
  const moov = buildMoov(offsets, useCo64);

  const mdatHeader = bigMdat
    ? fields([4, 1], [1, 0x6d], [1, 0x64], [1, 0x61], [1, 0x74], [8, mediaBytes + 16])
    : fields([4, mediaBytes + 8], [1, 0x6d], [1, 0x64], [1, 0x61], [1, 0x74]);
  const parts = [ftyp, moov, mdatHeader];
  for (const chunk of chunks) {
    const source = tracks[chunk.track].source;
    for (const sample of chunk.samples) parts.push(source.subarray(sample.offset, sample.offset + sample.size));
  }
  return parts;
}

// The whole job: one video-only recording plus one audio-only recording in,
// one playable MP4 out (as parts - see buildMp4). audioDelayMs shifts the
// audio later (or, negative, the video later) to correct a start-time gap.
export function mergeAudioVideo(videoBytes, audioBytes, { audioDelayMs = 0 } = {}) {
  const video = parseMp4(videoBytes).find((t) => t.handler === "vide");
  const audio = parseMp4(audioBytes).find((t) => t.handler === "soun");
  if (!video || video.samples.length === 0) throw new Error("mp4 merge: the video recording has no video samples");
  if (!audio || audio.samples.length === 0) throw new Error("mp4 merge: the audio recording has no audio samples");
  video.source = videoBytes;
  audio.source = audioBytes;
  video.delayMs = Math.max(0, -audioDelayMs);
  audio.delayMs = Math.max(0, audioDelayMs);
  return buildMp4([video, audio]);
}

export function concatParts(parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
