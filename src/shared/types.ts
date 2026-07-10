export type CaptionMode = 'manual' | 'ask' | 'auto';

export type SummaryStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type RetentionDays = 0 | 7 | 30 | 90; // 0 = never

export interface AIConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow: number;
}

export interface TranscriptionConfig {
  endpoint: string;        // base URL — POST {endpoint}/audio/transcriptions
  apiKey: string;
  model: string;           // whisper-1 / whisper-large-v3 / nova-3 / ...
  language?: 'vi' | 'en' | 'auto';
  // Chunking: split long audio for providers with file-size limits.
  chunkMinutes: number;    // default 10
  silenceAwareSplit: boolean; // default true
  diarization?: boolean;   // tách speaker — chỉ effective với provider hỗ trợ
  // Prompt biases Whisper toward correct vocabulary, punctuation, style.
  // Useful for Vietnamese meetings with mixed English tech terms.
  prompt?: string;
}

export interface DraftEmailLabels {
  ketQuaChinh: string;
  noiDungThongNhat: string;
  actionItems: string;
  ruiRo: string;
  buocTiepTheo: string;
}

export interface SummaryPreferences {
  includeMeetingInfo: boolean;
  includeSummary: boolean;
  includeDiscussionTopics: boolean;
  includeKeyOpinions: boolean;
  includeActionItems: boolean;
  includeDecisions: boolean;
  includePendingIssues: boolean;
  includeNextSteps: boolean;
  includeKeyQuotes: boolean;
  includeDraftEmail: boolean;
  draftEmailLabels?: Partial<DraftEmailLabels>;
  customSystemPrompt?: string;
}

// PII masking — pseudonymize sensitive entities locally BEFORE the transcript
// leaves the device for the AI endpoint, then restore the real values in the
// returned summary. The external model never sees real names/orgs/contacts.
export interface MaskingPreferences {
  enabled: boolean;
  // Replace speaker labels + participant names (the most reliable PII source).
  maskSpeakers: boolean;
  // User-maintained list of org/project/client names + sensitive terms.
  useDictionary: boolean;
  dictionary: string; // one entry per line (commas also accepted)
  // Regex-based contact/identifier scrubbing.
  maskEmails: boolean;
  maskPhones: boolean;
  maskIds: boolean; // CCCD / mã NV / long digit sequences
  // Experimental heuristic detector for Vietnamese proper nouns (names/orgs)
  // not covered by the lists above. May over- or under-mask.
  heuristicNames: boolean;
}

export interface UserSettings {
  ai: AIConfig;
  transcription?: TranscriptionConfig;
  captionMode: CaptionMode;
  retentionDays: RetentionDays;
  summary: SummaryPreferences;
  masking?: MaskingPreferences;
  language: 'vi' | 'en' | 'auto';
  consentAccepted: boolean;
}

export type TranscriptSource = 'text' | 'audio';

export interface TranscriptLine {
  speaker: string;
  text: string;
  ts: number; // epoch ms — first time the block appeared
  hash: string; // dedupe key: speaker + normalizedText
  // Stable per-DOM-block id from the content script. When present, the line
  // is upserted (replace-in-place) instead of appended — so live caption
  // updates don't pile up duplicates.
  blockId?: string;
  // Where the line came from. Defaults to 'text' when missing (legacy lines /
  // live captions / manual paste).
  source?: TranscriptSource;
}

export interface TranscriptGap {
  type: 'pause';
  from: number;
  to: number;
}

export type TranscriptEntry = TranscriptLine | TranscriptGap;

export interface TranscriptRecord {
  id: string; // meetingId
  lines: TranscriptEntry[];
  createdAt: number;
}

export interface ActionItem {
  text: string;
  assignee?: string;
  due?: string;
  priority?: string;
  status?: string;
}

export interface DraftEmail {
  subject: string;
  body: string;
}

export interface MeetingRecord {
  id: string;
  title: string;
  summary?: string;
  actionItems: ActionItem[];
  decisions: string[];
  pendingIssues: string[];
  draftEmail?: DraftEmail;
  keywords?: string[];
  meetingDate?: string;
  meetingTime?: string;
  meetingFormat?: string;
  participants?: string[];
  chair?: string;
  objective?: string;
  summaryStatus: SummaryStatus;
  summaryError?: string;
  calendarEventId?: string;
  duration: number; // seconds
  createdAt: number;
  updatedAt: number;
  audio?: AudioRecord;
}

export interface AudioRecord {
  storage: 'fs' | 'downloads';
  filename: string;
  downloadId?: number;
  startedAt: number;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  // True when the blob is also persisted in IndexedDB (STORE_AUDIOS) so
  // History can play it inline without depending on chrome.downloads.
  hasInlineBlob?: boolean;
}

export interface RecordingStatus {
  state: 'idle' | 'recording' | 'finalizing';
  meetingId?: string;
  startedAt?: number;
  error?: string;
}

// ---- message protocol (content/popup <-> background) ----

export type Message =
  | { type: 'CAPTURE_START'; meetingId: string; title: string }
  | { type: 'CAPTURE_LINE'; meetingId: string; line: TranscriptLine }
  | { type: 'CAPTURE_PAUSE'; meetingId: string; at: number }
  | { type: 'CAPTURE_RESUME'; meetingId: string; at: number }
  | { type: 'CAPTURE_END'; meetingId: string }
  | { type: 'SUMMARIZE'; meetingId: string }
  | { type: 'GET_STATUS' }
  | { type: 'GET_MEETING'; meetingId: string }
  | { type: 'LIST_MEETINGS'; limit?: number }
  | { type: 'DELETE_MEETING'; meetingId: string }
  | { type: 'TOGGLE_CC'; enable: boolean }
  | { type: 'MAIN_WORLD_CLICK_CC' }
  | { type: 'RECORDING_START'; meetingId: string; tabId: number; includeMic: boolean }
  | { type: 'RECORDING_STOP' }
  | { type: 'RECORDING_STATUS' }
  // Offscreen ↔ SW
  | { type: 'OFFSCREEN_READY' }
  | { type: 'OFFSCREEN_DONE'; blobUrl: string; sizeBytes: number; durationMs: number; mimeType: string }
  | { type: 'OFFSCREEN_ERROR'; error: string };

export interface CaptureStatus {
  meetingId?: string;
  title?: string;
  state: 'idle' | 'waiting' | 'capturing' | 'paused' | 'no-cc';
  lineCount: number;
  startedAt?: number;
}
