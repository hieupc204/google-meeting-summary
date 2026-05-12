// Audio processing helpers for in-browser transcription. Decodes uploaded
// audio with Web Audio API, finds silence regions, slices into chunks, and
// re-encodes each chunk as 16kHz mono WAV — the format Whisper-class APIs
// are tuned for. No external libs needed for WAV; lamejs is loaded lazily
// only when MP3 output is requested (smaller upload, but +150KB bundle).

export interface AudioChunk {
  blob: Blob;            // encoded WAV/MP3
  startSec: number;      // chunk start in original audio (seconds)
  endSec: number;
  sizeBytes: number;
}

const TARGET_SAMPLE_RATE = 16_000; // mono 16kHz

// Decode any browser-supported audio format (mp3/wav/m4a/webm/ogg/flac) into
// raw PCM AudioBuffer. May fail for AMR/Opus on some browsers — caller
// should catch + show a friendly error.
export async function decodeAudio(file: File | Blob): Promise<AudioBuffer> {
  const arrayBuf = await file.arrayBuffer();
  // OfflineAudioContext supports decodeAudioData and doesn't auto-play.
  // Use a small dummy context just for decoding.
  const Ctx =
    (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    ctx.close();
  }
}

// Resample the AudioBuffer to mono 16kHz. Whisper expects this rate; sending
// higher-rate stereo audio uploads more bytes for no quality gain.
export async function resampleToMono16k(buf: AudioBuffer): Promise<Float32Array> {
  const targetLength = Math.ceil((buf.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  // Mix down to mono by averaging channels.
  const merged = offline.createBuffer(1, buf.length, buf.sampleRate);
  const dst = merged.getChannelData(0);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    for (let i = 0; i < src.length; i++) dst[i] += src[i] / buf.numberOfChannels;
  }
  const src = offline.createBufferSource();
  src.buffer = merged;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// Find indices (in target-sample-rate samples) where a long-enough run of
// quiet samples exists. Used to choose chunk boundaries that don't cut a
// word in half.
//
// Returns { centerSamples: number[] } — the midpoint of each detected
// silence region.
export function findSilenceRegions(
  samples: Float32Array,
  opts: {
    minSilenceMs?: number;     // default 400
    rmsThreshold?: number;     // default 0.005 (linear, ~ -46 dBFS)
  } = {},
): number[] {
  const minSilenceMs = opts.minSilenceMs ?? 400;
  const threshold = opts.rmsThreshold ?? 0.005;
  const minSamples = Math.floor((minSilenceMs / 1000) * TARGET_SAMPLE_RATE);
  // 20ms windows; short enough to detect inter-word pauses.
  const windowSize = Math.floor(0.02 * TARGET_SAMPLE_RATE);
  const centers: number[] = [];
  let runStart = -1;

  for (let i = 0; i + windowSize <= samples.length; i += windowSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const s = samples[i + j];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / windowSize);
    if (rms < threshold) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= minSamples) {
        centers.push(Math.floor((runStart + i) / 2));
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && samples.length - runStart >= minSamples) {
    centers.push(Math.floor((runStart + samples.length) / 2));
  }
  return centers;
}

// Decide chunk boundaries (in samples). Each chunk is at most chunkSec
// long; we prefer to split inside a silence region near the target boundary.
export function planSplits(
  samples: Float32Array,
  chunkSec: number,
  silenceCenters: number[] | null,
): number[] {
  const chunkLen = chunkSec * TARGET_SAMPLE_RATE;
  const total = samples.length;
  if (total <= chunkLen) return [0, total];
  const splits: number[] = [0];
  let cursor = 0;
  while (cursor + chunkLen < total) {
    const targetEnd = cursor + chunkLen;
    // Search for a silence within ±15% of the target boundary.
    const searchRange = Math.floor(chunkLen * 0.15);
    let pick = targetEnd;
    if (silenceCenters && silenceCenters.length) {
      let best = -1;
      let bestDelta = Infinity;
      for (const c of silenceCenters) {
        if (c <= cursor) continue;
        const delta = Math.abs(c - targetEnd);
        if (delta < bestDelta && delta <= searchRange) {
          bestDelta = delta;
          best = c;
        }
      }
      if (best > 0) pick = best;
    }
    splits.push(pick);
    cursor = pick;
  }
  splits.push(total);
  return splits;
}

// Encode a chunk of mono 16kHz PCM as a WAV blob. WAV header is fixed-size
// (44 bytes) and the format is uncompressed PCM s16le, which every
// transcription provider accepts. ~1.92 MB per minute (16kHz × 16-bit ×
// 60s).
export function encodeWav16k(samples: Float32Array): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(view, 8, 'WAVE');
  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);            // sub-chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  // data chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);
  // Samples
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(off, s | 0, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

// Encode 16kHz mono PCM as MP3 (~6× smaller upload). Uses lamejs lazily —
// only loaded when this function is called.
export async function encodeMp3_16k(samples: Float32Array, kbps = 64): Promise<Blob> {
  const lame = await import('@breezystack/lamejs');
  const Encoder = lame.Mp3Encoder;
  const enc = new Encoder(1, TARGET_SAMPLE_RATE, kbps);
  // Convert Float32 [-1,1] to Int16.
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const parts: Uint8Array[] = [];
  const blockSize = 1152;
  for (let i = 0; i < int16.length; i += blockSize) {
    const block = int16.subarray(i, i + blockSize);
    const buf = enc.encodeBuffer(block);
    if (buf.length) parts.push(new Uint8Array(buf));
  }
  const flush = enc.flush();
  if (flush.length) parts.push(new Uint8Array(flush));
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

// High-level: split a decoded buffer into encoded chunks. Returns each
// chunk's blob + time bounds for downstream timestamp adjustment.
export async function chunkAudio(
  file: File,
  opts: {
    chunkMinutes: number;
    silenceAware: boolean;
    encoding?: 'mp3' | 'wav';
    onProgress?: (msg: string, pct?: number) => void;
  },
): Promise<AudioChunk[]> {
  opts.onProgress?.('Đang giải mã audio…');
  const buf = await decodeAudio(file);
  opts.onProgress?.('Đang chuẩn hoá audio…');
  const samples = await resampleToMono16k(buf);
  opts.onProgress?.('Đang phân tích khoảng lặng…');
  const silences = opts.silenceAware ? findSilenceRegions(samples) : null;
  const splits = planSplits(samples, opts.chunkMinutes * 60, silences);

  const chunks: AudioChunk[] = [];
  for (let i = 0; i < splits.length - 1; i++) {
    const start = splits[i];
    const end = splits[i + 1];
    const slice = samples.subarray(start, end);
    opts.onProgress?.(`Đang nén chunk ${i + 1}/${splits.length - 1}…`, (i / (splits.length - 1)) * 100);
    const blob =
      opts.encoding === 'mp3'
        ? await encodeMp3_16k(slice)
        : encodeWav16k(slice);
    chunks.push({
      blob,
      startSec: start / TARGET_SAMPLE_RATE,
      endSec: end / TARGET_SAMPLE_RATE,
      sizeBytes: blob.size,
    });
  }
  return chunks;
}
