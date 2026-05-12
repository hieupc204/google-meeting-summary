import { chunkAudio, type AudioChunk } from './audio';
import type { TranscriptionConfig } from './types';

export interface TranscribeProgress {
  phase: 'decode' | 'chunk' | 'transcribe' | 'merge';
  message: string;
  current?: number;
  total?: number;
  percent?: number;
}

export interface TranscribeSegment {
  speaker: string;       // best-effort; "Người nói" if provider doesn't tag
  text: string;
  startSec: number;
  endSec: number;
}

export interface TranscribeResult {
  text: string;          // joined transcript text suitable for the modal textarea
  segments: TranscribeSegment[];
}

const MAX_PER_CHUNK_BYTES = 24 * 1024 * 1024; // 24MB safety margin under most provider 25MB caps

// Send one audio chunk to an OpenAI-compatible /audio/transcriptions endpoint.
async function transcribeChunk(
  chunk: AudioChunk,
  cfg: TranscriptionConfig,
  filename: string,
): Promise<{ text: string; segments?: { start: number; end: number; text: string; speaker?: string }[] }> {
  const url = `${cfg.endpoint.replace(/\/+$/, '').trim()}/audio/transcriptions`;
  const fd = new FormData();
  fd.append('file', chunk.blob, filename);
  fd.append('model', cfg.model.trim());
  fd.append('response_format', 'verbose_json');
  // Deterministic output, less hallucination on silence/noise.
  fd.append('temperature', '0');
  if (cfg.language && cfg.language !== 'auto') fd.append('language', cfg.language);
  if (cfg.prompt && cfg.prompt.trim()) fd.append('prompt', cfg.prompt.trim());
  if (cfg.diarization) fd.append('diarization', 'true');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey.trim()}` },
      body: fd,
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new Error('Transcribe timeout (>5 phút) cho 1 chunk');
    throw new Error(`Fetch transcribe failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcribe API ${res.status}: ${body.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return (await res.json()) as { text: string; segments?: { start: number; end: number; text: string; speaker?: string }[] };
  }
  const text = await res.text();
  return { text };
}

export async function transcribeFile(
  file: File,
  cfg: TranscriptionConfig,
  onProgress?: (p: TranscribeProgress) => void,
): Promise<TranscribeResult> {
  if (!cfg.endpoint) throw new Error('Chưa cấu hình transcription endpoint');
  if (!cfg.apiKey) throw new Error('Chưa cấu hình transcription API key');

  // Decode + chunk + encode in browser.
  onProgress?.({ phase: 'decode', message: 'Đang giải mã audio…' });
  const chunks = await chunkAudio(file, {
    chunkMinutes: Math.max(1, cfg.chunkMinutes),
    silenceAware: cfg.silenceAwareSplit,
    encoding: 'mp3', // smaller upload; 16kHz mono speech compresses well at 64kbps
    onProgress: (msg, pct) => onProgress?.({ phase: 'chunk', message: msg, percent: pct }),
  });

  const segments: TranscribeSegment[] = [];
  const textParts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.sizeBytes > MAX_PER_CHUNK_BYTES) {
      throw new Error(`Chunk ${i + 1} quá lớn (${(c.sizeBytes / 1e6).toFixed(1)}MB). Giảm chunkMinutes trong settings.`);
    }
    onProgress?.({
      phase: 'transcribe',
      message: `Transcribe chunk ${i + 1}/${chunks.length} (${formatDuration(c.startSec)} → ${formatDuration(c.endSec)})…`,
      current: i + 1,
      total: chunks.length,
      percent: (i / chunks.length) * 100,
    });
    const ext = c.blob.type.includes('mpeg') ? 'mp3' : c.blob.type.includes('wav') ? 'wav' : 'audio';
    const result = await transcribeChunk(c, cfg, `chunk-${i + 1}.${ext}`);
    if (Array.isArray(result.segments) && result.segments.length) {
      for (const s of result.segments) {
        const text = (s.text ?? '').trim();
        if (!text) continue;
        if (isHallucination(text)) continue;
        segments.push({
          speaker: s.speaker ?? 'Người nói',
          text,
          startSec: c.startSec + (s.start ?? 0),
          endSec: c.startSec + (s.end ?? 0),
        });
      }
    } else if (result.text) {
      const cleaned = stripHallucinations(result.text.trim());
      if (cleaned) {
        segments.push({
          speaker: 'Người nói',
          text: cleaned,
          startSec: c.startSec,
          endSec: c.endSec,
        });
      }
    }
    textParts.push(result.text ?? segments[segments.length - 1]?.text ?? '');
  }

  onProgress?.({ phase: 'merge', message: 'Hợp nhất transcript…', percent: 100 });
  const text = textParts.map((t) => t.trim()).filter(Boolean).join('\n\n');
  return { text, segments };
}

// Whisper is famous for hallucinating boilerplate phrases on silence/noise:
// "subscribe to my channel", "thank you for watching", random Vietnamese
// YouTube spam. Drop segments matching these patterns.
const HALLUCINATION_PATTERNS = [
  /subscribe.*?(kênh|channel)/i,
  /(ghiền\s*mì\s*gõ|cảm\s*ơn\s*các\s*bạn\s*đã\s*theo\s*dõi)/i,
  /(thanks?\s+for\s+watching|like\s+and\s+subscribe)/i,
  /đăng\s*ký\s*kênh/i,
  /không\s*bỏ\s*lỡ\s*những\s*video/i,
  /^\s*\.+\s*$/, // just dots
  /^[\s​‌‍]*$/,  // empty / zero-width
];

function isHallucination(text: string): boolean {
  if (!text || text.trim().length < 3) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(text));
}

function stripHallucinations(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => s.trim() && !isHallucination(s))
    .join(' ')
    .trim();
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Convert TranscribeResult to a textarea-friendly format that survives the
// modal's parseTranscriptText round-trip.
//
// - Multi-speaker (diarized): "Speaker [MM:SS]" header before each speaker
//   change, then content lines.
// - Single-speaker (Whisper, no diarization): just "[MM:SS] text" per line.
//   The header form would mis-parse because timestamps contain ':'.
export function segmentsToTextareaFormat(
  segments: TranscribeSegment[],
): string {
  if (segments.length === 0) return '';
  const speakers = new Set(segments.map((s) => s.speaker));
  const multiSpeaker = speakers.size > 1;
  const lines: string[] = [];
  if (multiSpeaker) {
    let lastSpeaker = '';
    for (const s of segments) {
      if (s.speaker !== lastSpeaker) {
        const ts = formatDuration(s.startSec);
        lines.push('');
        lines.push(`${s.speaker.replace(/[:[\]]/g, '')} [${ts}]`);
        lastSpeaker = s.speaker;
      }
      lines.push(s.text);
    }
  } else {
    for (const s of segments) {
      const ts = formatDuration(s.startSec);
      lines.push(`[${ts}] ${s.text}`);
    }
  }
  return lines.join('\n').trim();
}
