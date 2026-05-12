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

export interface UserSettings {
  ai: AIConfig;
  transcription?: TranscriptionConfig;
  captionMode: CaptionMode;
  retentionDays: RetentionDays;
  summary: SummaryPreferences;
  language: 'vi' | 'en' | 'auto';
  consentAccepted: boolean;
}

export interface TranscriptLine {
  speaker: string;
  text: string;
  ts: number; // epoch ms — first time the block appeared
  hash: string; // dedupe key: speaker + normalizedText
  // Stable per-DOM-block id from the content script. When present, the line
  // is upserted (replace-in-place) instead of appended — so live caption
  // updates don't pile up duplicates.
  blockId?: string;
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
  summaryStatus: SummaryStatus;
  summaryError?: string;
  calendarEventId?: string;
  duration: number; // seconds
  createdAt: number;
  updatedAt: number;
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
  | { type: 'MAIN_WORLD_CLICK_CC' };

export interface CaptureStatus {
  meetingId?: string;
  title?: string;
  state: 'idle' | 'waiting' | 'capturing' | 'paused' | 'no-cc';
  lineCount: number;
  startedAt?: number;
}
