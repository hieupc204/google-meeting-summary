import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  appendTranscriptEntries,
  getAudioBlob,
  getTranscript,
  listRecentMeetings,
  saveMeeting,
  saveTranscript,
} from '@/shared/db';
import { transcribeFile, type TranscribeProgress } from '@/shared/transcribe';
import { mergeTranscriptsWithAI } from '@/shared/ai';
import { getSettings, setSettings as saveSettings } from '@/shared/storage';
import type {
  MeetingRecord,
  SummaryStatus,
  TranscriptEntry,
  TranscriptLine,
  TranscriptSource,
  TranscriptRecord,
  UserSettings,
} from '@/shared/types';
import {
  AIProviderSection,
  CaptionSection,
  SummarySection,
  CalendarSection,
  StorageSection,
} from '@/options/Options';
import '@/options/options.css';

type Section = 'history' | 'ai' | 'caption' | 'summary' | 'calendar' | 'storage';

function readInitialSection(): Section {
  const h = location.hash.replace('#', '');
  if (['history', 'ai', 'caption', 'summary', 'calendar', 'storage'].includes(h)) {
    return h as Section;
  }
  return 'history';
}

type Filter = 'all' | 'completed' | 'failed' | 'this-month';

const STATUS_BADGE: Record<SummaryStatus, { cls: string; label: string }> = {
  pending: { cls: 'badge-pending', label: '⏳ Pending' },
  processing: { cls: 'badge-processing', label: '⚙️ Processing' },
  completed: { cls: 'badge-completed', label: '✅ Completed' },
  failed: { cls: 'badge-failed', label: '⚠️ Failed' },
};

function isLine(e: TranscriptEntry): e is TranscriptLine {
  return (e as TranscriptLine).hash !== undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Tiny markdown renderer for the summary text. Handles: headings (## / ###),
// bold **x**, italics *x*, inline code `x`, bullet lists, and blank-line
// paragraph breaks. Output is sanitized (everything is escaped first).
function mdToHtml(md: string): string {
  // Strip any "## Từ khoá / Keywords / Tags" section — keywords have their
  // own tag-pill UI rendered separately from this markdown body. Older
  // summaries (saved before parser cleanup) still embed the section here;
  // strip at render time so they look clean without needing a re-summarize.
  md = md.replace(
    /^##\s*(?:🏷️\s*)?(?:Từ\s*khoá?|Keywords?|Tags?)\s*\n[\s\S]*?(?=\n##\s|$)/im,
    '',
  );
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let paragraph: string[] = [];
  const flushPara = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inlineMd(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushPara();
      closeList();
      continue;
    }
    // Strip legacy @TAGS marker from old summaries (kept for back-compat,
    // but no longer rendered — keywords are now a separate section).
    if (/^@TAGS:/.test(line)) continue;
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      flushPara();
      closeList();
      out.push(`<h4 class="md-h3">${inlineMd(h3[1])}</h4>`);
      continue;
    }
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      flushPara();
      closeList();
      out.push(`<h2 class="md-h1">${inlineMd(h1[1])}</h2>`);
      continue;
    }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushPara();
      closeList();
      out.push(`<h3 class="md-h2">${inlineMd(h2[1])}</h3>`);
      continue;
    }
    const li = line.match(/^[-*]\s+(.+)$/);
    if (li) {
      flushPara();
      if (!inList) {
        out.push('<ul class="md-list">');
        inList = true;
      }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    paragraph.push(line);
  }
  flushPara();
  closeList();
  return out.join('\n');
}

function inlineMd(s: string): string {
  let escaped = escapeHtml(s);
  escaped = escaped.replace(/\{\{TAG:([^}]+)\}\}/g, '<span class="md-tag">$1</span>');
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  return escaped;
}

// Parse free-form transcript text into TranscriptLine[].
// Auto-detects formats:
//   1. JSON wrapper: {"text": "..."} or {"lines": [...]}  → unwrap first
//   2. Multi-line block:                                  ← preferred when present
//        SPEAKER_1 [08/01/2026 16:28 PM]
//          line of content...
//          more content...
//        SPEAKER_2 [...]
//          ...
//   3. Inline:  "Speaker: text"  (one line per entry)
//   4. Plain text → single line, speaker = "Người nói"
async function parseTranscriptText(raw: string, source: TranscriptSource = 'text'): Promise<TranscriptLine[]> {
  // (1) Try JSON unwrap.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed);
      if (Array.isArray(obj)) {
        // Could be array of {speaker, text} or strings.
        const out: { speaker: string; text: string }[] = obj
          .map((x: unknown) => {
            if (typeof x === 'string') return { speaker: 'Người nói', text: x };
            const o = (x ?? {}) as Record<string, unknown>;
            return {
              speaker: String(o.speaker ?? o.name ?? 'Người nói'),
              text: String(o.text ?? o.content ?? ''),
            };
          })
          .filter((l) => l.text.trim());
        return await materialize(out, source);
      }
      if (typeof obj.text === 'string') raw = obj.text;
      else if (Array.isArray(obj.lines)) raw = obj.lines.map((l: { text?: string }) => l.text ?? '').join('\n');
    } catch {
      // not JSON → continue with raw text
    }
  }

  // (2) Detect multi-line speaker headers.
  // Header line examples that we accept (alone on a line):
  //   SPEAKER_1 [08/01/2026 16:28 PM]
  //   SPEAKER_12
  //   Anh Bằng [10:30]
  //   Hiếu:
  const headerRe =
    /^\s*(SPEAKER_\d+|[A-ZĐĂÂÊÔƠƯÝÀ-ỹ][^\[:]{0,60}?)\s*(?:\[([^\]]+)\])?\s*:?\s*$/;

  const sourceLines = raw.split(/\r?\n/);
  const blocks: { speaker: string; text: string }[] = [];
  let curSpeaker = 'Người nói';
  let curBuf: string[] = [];

  const flush = () => {
    const text = curBuf.join(' ').replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ speaker: curSpeaker, text });
    curBuf = [];
  };

  // First pass: count how many lines look like headers; if "many" use block parser,
  // otherwise fall back to inline parser.
  let headerCount = 0;
  for (const l of sourceLines) {
    if (headerRe.test(l.trim()) && /SPEAKER_\d+|\[/.test(l)) headerCount++;
  }

  if (headerCount >= 2) {
    // Block mode.
    for (const rawLine of sourceLines) {
      const line = rawLine.trim();
      const m = line.match(headerRe);
      if (m && (/SPEAKER_\d+/.test(line) || line.includes('['))) {
        flush();
        curSpeaker = m[1].trim();
        continue;
      }
      if (!line) continue; // blank lines separate utterances visually but we keep block
      curBuf.push(line);
    }
    flush();
  } else {
    // Inline mode: one line per entry, "Speaker: text" or fallback.
    let lastSpeaker = 'Người nói';
    const stripTs = (s: string) =>
      s.replace(/^\s*[\[(]?\d{1,2}[:.]\d{1,2}(?:[:.]\d{1,2})?[\])]?\s*/, '');
    const inlineRe = /^([^:]{2,40}):\s*(.+)$/;
    for (const rawLine of sourceLines) {
      const line = stripTs(rawLine).trim();
      if (!line) continue;
      const m = line.match(inlineRe);
      if (m) {
        const speaker = m[1].trim();
        const text = m[2].trim();
        if (text) {
          blocks.push({ speaker, text });
          lastSpeaker = speaker;
        }
      } else {
        blocks.push({ speaker: lastSpeaker, text: line });
      }
    }
  }

  return await materialize(blocks, source);
}

async function materialize(
  blocks: { speaker: string; text: string }[],
  source: TranscriptSource = 'text',
): Promise<TranscriptLine[]> {
  const out: TranscriptLine[] = [];
  const baseTs = Date.now();
  let i = 0;
  for (const b of blocks) {
    if (!b.text.trim()) continue;
    const data = new TextEncoder().encode(`${b.speaker}|${b.text.toLowerCase()}`);
    const buf = await crypto.subtle.digest('SHA-1', data);
    const hash = Array.from(new Uint8Array(buf))
      .slice(0, 8)
      .map((bb) => bb.toString(16).padStart(2, '0'))
      .join('');
    out.push({ speaker: b.speaker, text: b.text, ts: baseTs + i++ * 1000, hash, source });
  }
  return out;
}

async function createMeetingFromSources(
  title: string,
  textTranscript: string,
  audioLines: TranscriptLine[],
): Promise<string> {
  const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const textLines = textTranscript.trim()
    ? await parseTranscriptText(textTranscript, 'text')
    : [];
  await saveMeeting({
    id,
    title: title.trim() || `Cuộc họp ${new Date(now).toLocaleString('vi-VN')}`,
    actionItems: [],
    decisions: [],
    pendingIssues: [],
    summaryStatus: 'pending',
    duration: 0,
    createdAt: now,
    updatedAt: now,
  });
  const merged: TranscriptLine[] = [...audioLines, ...textLines];
  if (merged.length) await appendTranscriptEntries(id, merged);
  return id;
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString('vi-VN');
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Returns a blob URL to play the meeting's recorded audio inline, or null if
// no inline blob is stored. Caller is responsible for revoking the URL.
async function loadAudioBlobUrl(meeting: MeetingRecord): Promise<string | null> {
  if (!meeting.audio?.hasInlineBlob) return null;
  const rec = await getAudioBlob(meeting.id);
  if (!rec) return null;
  return URL.createObjectURL(rec.blob);
}

async function openAudioInOS(meeting: MeetingRecord) {
  const audio = meeting.audio;
  if (!audio?.downloadId) {
    alert('Meeting này không có file audio.');
    return;
  }
  try {
    const items = await chrome.downloads.search({ id: audio.downloadId });
    const item = items[0];
    if (!item || item.state !== 'complete' || item.exists === false) {
      alert('File audio không còn trên ổ đĩa (đã bị xoá hoặc di chuyển).');
      return;
    }
    await chrome.downloads.open(audio.downloadId);
  } catch (e) {
    console.error('[openAudioInOS]', e);
    alert(`Không mở được audio: ${(e as Error).message}`);
  }
}

export function History() {
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>(readInitialSection());
  const [settings, setSettingsState] = useState<UserSettings | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const reload = async () => setMeetings(await listRecentMeetings(100));

  useEffect(() => {
    reload();
    getSettings().then(setSettingsState);
    const onHash = () => setSection(readInitialSection());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Poll meeting list while any meeting is in 'processing' so the UI reflects
  // status changes even if the SUMMARIZE message handler is slow to respond
  // (or the service worker gets killed mid-fetch and the response is lost).
  const hasProcessing = meetings.some((m) => m.summaryStatus === 'processing');
  useEffect(() => {
    if (!hasProcessing) return;
    const id = setInterval(reload, 2000);
    return () => clearInterval(id);
  }, [hasProcessing]);

  const navigate = (s: Section) => {
    setSection(s);
    history.replaceState(null, '', `#${s}`);
  };

  const saveSettingsPatch = async (patch: Partial<UserSettings>) => {
    const next = await saveSettings(patch);
    setSettingsState(next);
  };

  const testApi = async () => {
    if (!settings) return;
    setTestStatus('Đang kiểm tra…');
    try {
      const res = await fetch(`${settings.ai.endpoint}/models`, {
        headers: { Authorization: `Bearer ${settings.ai.apiKey}` },
      });
      setTestStatus(res.ok ? '✅ Kết nối thành công' : `❌ ${res.status} ${res.statusText}`);
    } catch (e) {
      setTestStatus(`❌ ${(e as Error).message}`);
    }
  };

  const stats = useMemo(() => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const thisMonth = meetings.filter((m) => m.createdAt >= monthStart.getTime());
    const totalActionItems = meetings.reduce((s, m) => s + m.actionItems.length, 0);
    const totalSeconds = meetings.reduce((s, m) => s + m.duration, 0);
    return {
      monthCount: thisMonth.length,
      actionItems: totalActionItems,
      hours: Math.round(totalSeconds / 3600),
    };
  }, [meetings]);

  const filtered = useMemo(() => {
    return meetings.filter((m) => {
      if (filter === 'completed' && m.summaryStatus !== 'completed') return false;
      if (filter === 'failed' && m.summaryStatus !== 'failed') return false;
      if (filter === 'this-month') {
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        if (m.createdAt < monthStart.getTime()) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!m.title.toLowerCase().includes(q) && !(m.summary ?? '').toLowerCase().includes(q))
          return false;
      }
      return true;
    });
  }, [meetings, filter, search]);

  return (
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-logo">
          <img class="logo-icon" src={chrome.runtime.getURL('icons/icon-128.png')} alt="" />
          <div>
            <div class="logo-text">Meet Assistant</div>
            <div class="logo-sub">Meeting History</div>
          </div>
        </div>
        <div class="nav-section">
          <div class="nav-label">Menu</div>
          <div
            class={`nav-item ${section === 'history' ? 'active' : ''}`}
            onClick={() => navigate('history')}
          >
            <span class="nav-icon">🕐</span> Lịch sử
          </div>
        </div>
        <div class="nav-section">
          <div class="nav-label">Cấu hình</div>
          <div
            class={`nav-item ${section === 'ai' ? 'active' : ''}`}
            onClick={() => navigate('ai')}
          >
            <span class="nav-icon">🤖</span> AI Provider
          </div>
          <div
            class={`nav-item ${section === 'caption' ? 'active' : ''}`}
            onClick={() => navigate('caption')}
          >
            <span class="nav-icon">💬</span> Caption Mode
          </div>
          <div
            class={`nav-item ${section === 'summary' ? 'active' : ''}`}
            onClick={() => navigate('summary')}
          >
            <span class="nav-icon">📝</span> Summary
          </div>
        </div>
        <div class="nav-section">
          <div class="nav-label">Tích hợp</div>
          <div
            class={`nav-item ${section === 'calendar' ? 'active' : ''}`}
            onClick={() => navigate('calendar')}
          >
            <span class="nav-icon">📅</span> Google Calendar
          </div>
        </div>
        <div class="nav-section">
          <div class="nav-label">Dữ liệu</div>
          <div
            class={`nav-item ${section === 'storage' ? 'active' : ''}`}
            onClick={() => navigate('storage')}
          >
            <span class="nav-icon">💾</span> Lưu trữ &amp; Bảo mật
          </div>
        </div>
        <div class="sidebar-footer">
          <span>Meet Assistant v0.1</span>
        </div>
      </aside>

      <main class="main">
        {section !== 'history' && settings && (
          <>
            {section === 'ai' && (
              <AIProviderSection s={settings} save={saveSettingsPatch} />
            )}
            {section === 'caption' && <CaptionSection s={settings} save={saveSettingsPatch} />}
            {section === 'summary' && <SummarySection s={settings} save={saveSettingsPatch} />}
            {section === 'calendar' && <CalendarSection />}
            {section === 'storage' && <StorageSection s={settings} save={saveSettingsPatch} />}
          </>
        )}
        {section === 'history' && (
          <>
        <div class="page-header">
          <div>
            <div class="page-title">🕐 Lịch sử cuộc họp</div>
            <div class="page-subtitle">Toàn bộ transcript và summary được lưu local trên máy bạn.</div>
          </div>
        </div>

        <div class="toolbar">
          <button
            class="action-btn action-btn-primary"
            style={{ padding: '8px 14px' }}
            onClick={() => setShowCreate(true)}
          >
            ＋ Tạo cuộc họp mới
          </button>
          <div class="search-box">
            <span class="search-icon">🔍</span>
            <input
              class="search-input"
              type="text"
              placeholder="Tìm kiếm transcript, action items, người tham gia..."
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
          </div>
          {(
            [
              ['all', '📋 Tất cả'],
              ['completed', '✅ Completed'],
              ['failed', '⚠️ Failed'],
              ['this-month', '📅 Tháng này'],
            ] as [Filter, string][]
          ).map(([val, label]) => (
            <button
              class={`filter-btn ${filter === val ? 'active' : ''}`}
              onClick={() => setFilter(val)}
            >
              {label}
            </button>
          ))}
        </div>

        <div class="meeting-split">
          <div class="meeting-listcol">
            {filtered.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', padding: 20 }}>
                {meetings.length === 0
                  ? 'Chưa có cuộc họp nào. Tham gia Google Meet để bắt đầu.'
                  : 'Không có meeting nào khớp bộ lọc.'}
              </p>
            ) : (
              filtered.map((m) => (
                <MeetingListItem
                  key={m.id}
                  meeting={m}
                  selected={selectedId === m.id}
                  onSelect={() => setSelectedId(m.id)}
                />
              ))
            )}
          </div>
          <div class="meeting-detailcol">
            {(() => {
              const selected = filtered.find((m) => m.id === selectedId) ?? filtered[0] ?? null;
              if (!selected) {
                return (
                  <div class="meeting-detail-empty">
                    <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
                    <p>Chọn 1 cuộc họp ở danh sách bên trái để xem chi tiết.</p>
                  </div>
                );
              }
              return (
                <MeetingCard
                  key={selected.id}
                  meeting={selected}
                  expanded={true}
                  onToggle={() => {}}
                  onDelete={async () => {
                    if (confirm(`Xóa "${selected.title}"?`)) {
                      const { deleteMeeting } = await import('@/shared/db');
                      await deleteMeeting(selected.id);
                      setSelectedId(null);
                      await reload();
                    }
                  }}
                  onRetry={async () => {
                    setMeetings((prev) =>
                      prev.map((mm) =>
                        mm.id === selected.id
                          ? { ...mm, summaryStatus: 'processing', summaryError: undefined }
                          : mm,
                      ),
                    );
                    chrome.runtime.sendMessage({ type: 'SUMMARIZE', meetingId: selected.id });
                    setTimeout(reload, 500);
                  }}
                />
              );
            })()}
          </div>
        </div>
          </>
        )}
      </main>
      {showCreate && (
        <CreateMeetingModal
          onClose={() => setShowCreate(false)}
          onCreated={async (id, runSummarize) => {
            setShowCreate(false);
            await reload();
            if (runSummarize) {
              chrome.runtime.sendMessage({ type: 'SUMMARIZE', meetingId: id });
              setTimeout(reload, 500);
            }
          }}
        />
      )}
    </div>
  );
}

function CreateMeetingModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string, runSummarize: boolean) => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [audioLines, setAudioLines] = useState<TranscriptLine[]>([]);
  const [audioPreview, setAudioPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeMsg, setTranscribeMsg] = useState('');
  const [transcribePct, setTranscribePct] = useState(0);

  const isAudioFile = (file: File): boolean => {
    if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true;
    const name = file.name.toLowerCase();
    return /\.(mp3|wav|m4a|webm|ogg|oga|flac|aac|opus)$/.test(name);
  };

  const handleAudio = async (file: File) => {
    setError(null);
    setTranscribing(true);
    setTranscribeMsg('Đang chuẩn bị…');
    setTranscribePct(0);
    try {
      const settings = await getSettings();
      const cfg = settings.transcription;
      if (!cfg?.endpoint || !cfg?.apiKey || !cfg?.model) {
        throw new Error(
          'Chưa cấu hình transcription. Vào Settings → Transcription để cấu hình endpoint + API key.',
        );
      }
      const { transcribeFile, segmentsToTextareaFormat } = await import('@/shared/transcribe');
      const result = await transcribeFile(file, cfg, (p) => {
        setTranscribeMsg(p.message);
        if (typeof p.percent === 'number') setTranscribePct(p.percent);
      });
      const text = segmentsToTextareaFormat(result.segments) || result.text;
      const lines = await parseTranscriptText(text, 'audio');
      setAudioLines((prev) => [...prev, ...lines]);
      setAudioPreview((prev) => (prev ? `${prev}\n\n${text}` : text));
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setError(`Lỗi transcribe: ${(err as Error).message}`);
    } finally {
      setTranscribing(false);
      setTranscribeMsg('');
      setTranscribePct(0);
    }
  };

  const onFile = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      if (isAudioFile(file)) {
        await handleAudio(file);
        return;
      }
      const text = await file.text();
      setContent((prev) => (prev ? prev + '\n' + text : text));
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setError(`Không đọc được file: ${(err as Error).message}`);
    }
    // Reset input so re-uploading same file fires onChange.
    (e.target as HTMLInputElement).value = '';
  };

  const submit = async (runSummarize: boolean) => {
    if (!content.trim() && audioLines.length === 0) {
      setError('Vui lòng nhập text hoặc upload audio để transcribe.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await createMeetingFromSources(title, content, audioLines);
      onCreated(id, runSummarize);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <div class="modal-title">＋ Tạo cuộc họp mới từ transcript</div>
          <button class="modal-close" onClick={onClose}>×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Tiêu đề cuộc họp</label>
            <input
              class="form-input"
              type="text"
              placeholder="VD: Sprint planning 23/03"
              value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="form-group">
            <label class="form-label">
              Upload file transcript (.txt, .md, .vtt, .srt) hoặc audio (.mp3, .wav, .m4a, .webm, .ogg, .flac)
            </label>
            <input
              class="form-input"
              type="file"
              accept=".txt,.md,.vtt,.srt,.json,text/plain,audio/*,video/webm,.mp3,.wav,.m4a,.webm,.ogg,.flac,.aac,.opus"
              onChange={onFile}
              disabled={transcribing}
            />
            <span class="form-hint">
              File audio sẽ được chia chunk + transcribe tự động bằng provider trong{' '}
              <code>Settings → Transcription</code>. File text paste / upload thì điền thẳng vào
              ô bên dưới.
            </span>
          </div>
          {transcribing && (
            <div class="modal-error" style={{ background: '#eef2ff', borderColor: '#c7d2fe', color: '#1d2eb6' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span class="spinner" style={{ borderColor: '#1d2eb6', borderRightColor: 'transparent' }} />
                <span><b>Đang transcribe audio…</b> {transcribeMsg}</span>
              </div>
              {transcribePct > 0 && (
                <div
                  style={{
                    marginTop: 8,
                    height: 6,
                    background: '#e0e7ff',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, transcribePct)}%`,
                      height: '100%',
                      background: '#1d2eb6',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {audioLines.length > 0 && (
            <div class="form-group">
              <label class="form-label">
                🎙️ Audio transcript ({audioLines.length} dòng) — sẽ lưu với nguồn "Audio"
                <button
                  type="button"
                  class="action-btn action-btn-ghost"
                  style={{ marginLeft: 12, padding: '2px 8px', fontSize: 11 }}
                  onClick={() => { setAudioLines([]); setAudioPreview(''); }}
                >
                  ✕ Xoá
                </button>
              </label>
              <textarea
                class="form-textarea"
                rows={6}
                readOnly
                style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, background: '#f0fdf4', borderColor: '#a7f3d0' }}
                value={audioPreview}
              />
            </div>
          )}
          <div class="form-group">
            <label class="form-label">📝 Text transcript — sẽ lưu với nguồn "Text"</label>
            <textarea
              class="form-textarea"
              rows={14}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              placeholder={'SPEAKER_0: Hôm nay chúng ta sẽ thảo luận về...\nSPEAKER_1: Tôi nghĩ chúng ta nên...'}
              value={content}
              onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
            />
          </div>
          {error && <div class="modal-error">⚠️ {error}</div>}
        </div>
        <div class="modal-footer">
          <button class="action-btn action-btn-ghost" onClick={onClose} disabled={busy || transcribing}>
            Huỷ
          </button>
          <button
            class="action-btn action-btn-primary"
            onClick={() => submit(false)}
            disabled={busy || transcribing}
          >
            💾 Chỉ lưu
          </button>
          <button
            class="action-btn action-btn-primary"
            onClick={() => submit(true)}
            disabled={busy || transcribing}
            style={{ background: 'var(--primary)', color: '#fff' }}
          >
            {busy ? '⏳ Đang tạo…' : '✦ Lưu & tóm tắt'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <div class="stat-card">
      <div class="stat-icon">{icon}</div>
      <div class="stat-value">{value}</div>
      <div class="stat-label">{label}</div>
    </div>
  );
}

function MeetingListItem({
  meeting,
  selected,
  onSelect,
}: {
  meeting: MeetingRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const badge = STATUS_BADGE[meeting.summaryStatus];
  return (
    <div
      class={`meeting-list-item ${selected ? 'selected' : ''} ${
        meeting.summaryStatus === 'processing' ? 'processing' : ''
      }`}
      onClick={onSelect}
    >
      <div class="meeting-list-title">{meeting.title}</div>
      <div class="meeting-list-meta">
        <span>📅 {fmtDate(meeting.createdAt)}</span>
        <span>🕐 {fmtTime(meeting.createdAt)}</span>
        <span>⏱️ {Math.round(meeting.duration / 60)}p</span>
      </div>
      <div class="meeting-list-foot">
        <span
          class={`status-badge ${badge.cls}`}
          title={`Trạng thái tóm tắt: ${badge.label}`}
        >
          {badge.label}
        </span>
        {meeting.actionItems.length > 0 && (
          <span
            class="meeting-list-tag"
            title={`${meeting.actionItems.length} đầu việc cần thực hiện`}
          >
            ✅ {meeting.actionItems.length}
          </span>
        )}
        {meeting.decisions.length > 0 && (
          <span
            class="meeting-list-tag"
            title={`${meeting.decisions.length} quyết định đã thống nhất`}
          >
            🟢 {meeting.decisions.length}
          </span>
        )}
        {meeting.pendingIssues && meeting.pendingIssues.length > 0 && (
          <span
            class="meeting-list-tag"
            title={`${meeting.pendingIssues.length} rủi ro / vấn đề tồn đọng`}
          >
            ⚠️ {meeting.pendingIssues.length}
          </span>
        )}
        {meeting.audio?.downloadId != null && (
          <span
            class="meeting-list-tag meeting-list-tag-audio"
            title={`Có bản ghi audio (${formatBytes(meeting.audio.sizeBytes)} · ${Math.round(
              meeting.audio.durationMs / 1000,
            )}s)`}
          >
            🎙️
          </span>
        )}
      </div>
    </div>
  );
}

function MeetingCard({
  meeting,
  expanded,
  onToggle,
  onDelete,
  onRetry,
}: {
  meeting: MeetingRecord;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const [tab, setTab] = useState<'summary' | 'transcript' | 'audio-transcript' | 'merged-transcript' | 'draft-email'>('summary');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'text' | 'audio'>('all');
  const [transcript, setTranscript] = useState<TranscriptRecord | null>(null);
  const [audioTranscript, setAudioTranscript] = useState<TranscriptRecord | null>(null);
  const [mergedTranscript, setMergedTranscript] = useState<TranscriptRecord | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeMsg, setTranscribeMsg] = useState('');
  const [merging, setMerging] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingDoc, setExportingDoc] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);

  const audioTranscriptId = `${meeting.id}:audio`;
  const mergedTranscriptId = `${meeting.id}:merged`;

  // Revoke blob URL on unmount / when audio changes to prevent leaks.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const togglePlayInline = async () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      return;
    }
    if (!meeting.audio?.hasInlineBlob) {
      await openAudioInOS(meeting);
      return;
    }
    setAudioLoading(true);
    try {
      const url = await loadAudioBlobUrl(meeting);
      if (url) setAudioUrl(url);
      else await openAudioInOS(meeting);
    } finally {
      setAudioLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && !transcript) {
      getTranscript(meeting.id).then((t) => setTranscript(t ?? null));
    }
  }, [expanded, meeting.id, transcript]);

  useEffect(() => {
    if (expanded && !audioTranscript) {
      getTranscript(audioTranscriptId).then((t) => setAudioTranscript(t ?? null));
    }
  }, [expanded, audioTranscriptId, audioTranscript]);

  useEffect(() => {
    if (expanded && !mergedTranscript) {
      getTranscript(mergedTranscriptId).then((t) => setMergedTranscript(t ?? null));
    }
  }, [expanded, mergedTranscriptId, mergedTranscript]);

  const mergeTranscripts = async () => {
    if (merging) return;
    const captionLines = (transcript?.lines ?? []).filter(isLine);
    const audioLines = (audioTranscript?.lines ?? []).filter(isLine);
    if (captionLines.length === 0) {
      alert('Chưa có caption transcript (live captions từ Meet) để merge.');
      return;
    }
    if (audioLines.length === 0) {
      alert('Chưa có audio transcript. Bấm "🎙️ Transcribe" trước.');
      return;
    }
    setMerging(true);
    try {
      const settings = await getSettings();
      const merged = await mergeTranscriptsWithAI(meeting, captionLines, audioLines, settings);
      const record: TranscriptRecord = {
        id: mergedTranscriptId,
        lines: merged,
        createdAt: Date.now(),
      };
      await saveTranscript(record);
      setMergedTranscript(record);
      setTab('merged-transcript');
    } catch (e) {
      console.error('[Merge transcripts]', e);
      alert(`Merge lỗi: ${(e as Error).message}`);
    } finally {
      setMerging(false);
    }
  };

  const transcribeAudio = async () => {
    if (transcribing) return;
    const rec = await getAudioBlob(meeting.id);
    if (!rec) {
      alert('Không tìm thấy file audio cho meeting này.');
      return;
    }
    const settings = await getSettings();
    const cfg = settings.transcription;
    if (!cfg?.endpoint || !cfg?.apiKey) {
      alert('Chưa cấu hình Transcription. Vào Settings → Transcription để cấu hình endpoint + API key.');
      return;
    }
    setTranscribing(true);
    setTranscribeMsg('Đang chuẩn bị…');
    try {
      const ext = rec.mimeType.includes('mpeg') ? 'mp3'
        : rec.mimeType.includes('wav') ? 'wav'
        : rec.mimeType.includes('webm') ? 'webm'
        : rec.mimeType.includes('ogg') ? 'ogg' : 'audio';
      const file = new File([rec.blob], `${meeting.id}.${ext}`, { type: rec.mimeType });
      const onProgress = (p: TranscribeProgress) => {
        const pct = typeof p.percent === 'number' ? ` (${Math.round(p.percent)}%)` : '';
        setTranscribeMsg(`${p.message}${pct}`);
      };
      const result = await transcribeFile(file, cfg, onProgress);
      const lines: TranscriptLine[] = result.segments.map((s, i) => ({
        speaker: s.speaker,
        text: s.text,
        ts: meeting.createdAt + Math.max(0, s.startSec) * 1000,
        hash: `audio:${i}:${s.startSec}:${s.text.slice(0, 32)}`,
        source: 'audio' as TranscriptSource,
      }));
      const record: TranscriptRecord = {
        id: audioTranscriptId,
        lines,
        createdAt: Date.now(),
      };
      await saveTranscript(record);
      setAudioTranscript(record);
      setTab('audio-transcript');
    } catch (e) {
      console.error('[Transcribe audio]', e);
      alert(`Transcribe lỗi: ${(e as Error).message}`);
    } finally {
      setTranscribing(false);
      setTranscribeMsg('');
    }
  };

  const badge = STATUS_BADGE[meeting.summaryStatus];
  const lineCount = transcript?.lines.filter(isLine).length ?? 0;
  const safeName = meeting.title.replace(/[^\w]+/g, '-');

  const exportTranscriptMd = async () => {
    const t = transcript ?? (await getTranscript(meeting.id));
    const md = renderTranscriptMarkdown(meeting, t ?? null);
    download(md, `${safeName}-transcript.md`, 'text/markdown');
  };

  const exportSummaryPdf = async () => {
    setExportingPdf(true);
    try {
      await downloadSummaryPdf(meeting, safeName);
    } catch (e) {
      console.error('[Export PDF]', e);
      alert(`Export PDF lỗi: ${(e as Error).message}`);
    } finally {
      setExportingPdf(false);
    }
  };

  const exportSummaryDoc = async () => {
    setExportingDoc(true);
    try {
      const blob = await buildSummaryDocx(meeting);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}-summary.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('[Export Word]', e);
      alert(`Export Word lỗi: ${(e as Error).message}`);
    } finally {
      setExportingDoc(false);
    }
  };

  const copySummaryMd = async () => {
    await navigator.clipboard.writeText(renderSummaryMarkdown(meeting));
  };

  return (
    <>
      {(exportingPdf || exportingDoc) && (
        <div class="export-overlay" onClick={(e) => e.stopPropagation()}>
          <div class="export-loader">
            <div class="export-spinner" />
            <div class="export-loader-title">
              {exportingPdf ? 'Đang tạo PDF…' : 'Đang tạo Word…'}
            </div>
            <div class="export-loader-sub">
              Render nội dung và đóng gói file. Việc này có thể mất vài giây cho meeting dài.
            </div>
          </div>
        </div>
      )}
    <div
      class={`meeting-card ${expanded ? 'expanded' : ''} ${
        meeting.summaryStatus === 'processing' ? 'processing' : ''
      }`}
      onClick={onToggle}
    >
      <div class="meeting-sticky-head">
      <div class="meeting-card-header">
        <div class="meeting-header-row">
          <div class="meeting-title-row">
            <span class="meeting-title">{meeting.title}</span>
            <span class={`status-badge ${badge.cls}`}>{badge.label}</span>
            {meeting.calendarEventId && <span class="cal-badge">📅 Calendar synced</span>}
          </div>
        <div class="meeting-right" onClick={(e) => e.stopPropagation()}>
          <button
            class={`action-btn action-btn-primary ${
              meeting.summaryStatus === 'processing' ? 'action-btn-processing' : ''
            }`}
            onClick={onRetry}
            disabled={meeting.summaryStatus === 'processing'}
            style={
              meeting.summaryStatus === 'processing'
                ? { cursor: 'not-allowed', opacity: 0.85 }
                : undefined
            }
          >
            {meeting.summaryStatus === 'processing' ? (
              <>
                <span class="spinner" /> Đang tóm tắt, vui lòng đợi…
              </>
            ) : meeting.summaryStatus === 'completed' ? (
              '♻️ Tóm tắt lại'
            ) : meeting.summaryStatus === 'failed' ? (
              '🔁 Thử lại'
            ) : (
              '✦ Tóm tắt'
            )}
          </button>
          <ExportMenu
            label="📤 Export summary"
            options={[
              { label: '📄 PDF', onSelect: exportSummaryPdf },
              { label: '📝 Word (.doc)', onSelect: exportSummaryDoc },
            ]}
          />
          <button class="action-btn action-btn-primary" onClick={exportTranscriptMd}>
            📤 Export transcript
          </button>
          <button class="action-btn action-btn-ghost" onClick={onDelete}>
            🗑️
          </button>
        </div>
        </div>
        <div class="meeting-meta">
          <span>📅 {fmtDate(meeting.createdAt)}</span>
          <span>🕐 {fmtTime(meeting.createdAt)}</span>
          <span>⏱️ {Math.round(meeting.duration / 60)} phút</span>
          {meeting.audio?.downloadId != null && (
            <button
              class="action-btn action-btn-ghost action-btn-audio meeting-meta-audio"
              title={
                meeting.audio.hasInlineBlob
                  ? `Phát audio inline (${formatBytes(meeting.audio.sizeBytes)})`
                  : `Mở audio bằng app hệ thống (${formatBytes(meeting.audio.sizeBytes)})`
              }
              onClick={(e) => {
                e.stopPropagation();
                togglePlayInline();
              }}
              disabled={audioLoading}
            >
              {audioLoading ? '⏳' : audioUrl ? '⏹️ Ẩn' : '▶️ Audio'}
            </button>
          )}
          {meeting.audio?.hasInlineBlob && (
            <button
              class="action-btn action-btn-ghost action-btn-audio meeting-meta-audio"
              title={
                audioTranscript
                  ? 'Transcribe lại audio (ghi đè bản hiện tại)'
                  : 'Chuyển audio thành văn bản (Speech-to-Text)'
              }
              onClick={(e) => {
                e.stopPropagation();
                transcribeAudio();
              }}
              disabled={transcribing}
            >
              {transcribing ? `⏳ ${transcribeMsg || 'Đang transcribe…'}` : audioTranscript ? '♻️ Transcribe lại' : '🎙️ Transcribe'}
            </button>
          )}
          {audioTranscript && (transcript?.lines.filter(isLine).length ?? 0) > 0 && (
            <button
              class="action-btn action-btn-ghost action-btn-audio meeting-meta-audio"
              title="Dùng AI ghép caption (tên người nói) với audio transcript (text chính xác)"
              onClick={(e) => {
                e.stopPropagation();
                mergeTranscripts();
              }}
              disabled={merging}
            >
              {merging ? '⏳ Đang merge…' : mergedTranscript ? '♻️ Merge lại (AI)' : '🔀 Merge (AI)'}
            </button>
          )}
        </div>
      </div>

      {audioUrl && (
        <div class="meeting-audio-player">
          <audio src={audioUrl} controls preload="metadata" style={{ width: '100%' }} />
        </div>
      )}

      {expanded && (
        <div class="meeting-tabs">
          <div
            class={`meeting-tab ${tab === 'summary' ? 'active' : ''}`}
            onClick={() => setTab('summary')}
          >
            📝 Summary
          </div>
          <div
            class={`meeting-tab ${tab === 'transcript' ? 'active' : ''}`}
            onClick={() => setTab('transcript')}
          >
            💬 Transcript ({lineCount})
          </div>
          {(meeting.audio?.hasInlineBlob || audioTranscript) && (
            <div
              class={`meeting-tab ${tab === 'audio-transcript' ? 'active' : ''}`}
              onClick={() => setTab('audio-transcript')}
            >
              🎙️ Audio Transcript ({audioTranscript?.lines.filter(isLine).length ?? 0})
            </div>
          )}
          {mergedTranscript && (
            <div
              class={`meeting-tab ${tab === 'merged-transcript' ? 'active' : ''}`}
              onClick={() => setTab('merged-transcript')}
            >
              🔀 Merged ({mergedTranscript.lines.filter(isLine).length})
            </div>
          )}
          <div
            class={`meeting-tab ${tab === 'draft-email' ? 'active' : ''}`}
            onClick={() => setTab('draft-email')}
          >
            📧 Draft Email
          </div>
        </div>
      )}
      </div>
      {expanded && (
        <div class="meeting-body" onClick={(e) => e.stopPropagation()}>

          {tab === 'summary' ? (
            <div class="tab-content active">
              {meeting.summaryStatus === 'failed' && meeting.summaryError && (
                <div
                  class="summary-section"
                  style={{
                    background: '#fee',
                    border: '1px solid #f99',
                    padding: 12,
                    borderRadius: 6,
                  }}
                >
                  <div class="summary-heading" style={{ color: '#c33' }}>⚠️ Lỗi tóm tắt</div>
                  <div class="summary-text" style={{ color: '#933', fontSize: 12 }}>
                    {meeting.summaryError}
                  </div>
                </div>
              )}
              {meeting.summary ? (
                <div class="summary-section">
                  <div class="summary-heading">📌 Tóm tắt</div>
                  <div
                    class="summary-text md-body"
                    dangerouslySetInnerHTML={{
                      __html: mdToHtml(meeting.summary),
                    }}
                  />
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)' }}>Chưa có summary.</p>
              )}
              {meeting.actionItems.length > 0 && (
                <div class="summary-section">
                  <div class="summary-heading">✅ Action Items ({meeting.actionItems.length})</div>
                  <div class="action-items">
                    {meeting.actionItems.map((a, i) => (
                      <div class="action-item" key={i}>
                        <div class="action-check" />
                        <div style={{ flex: 1 }}>
                          <div class="action-item-text">{a.text}</div>
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              marginTop: 2,
                              display: 'flex',
                              gap: 8,
                              flexWrap: 'wrap',
                            }}
                          >
                            {a.due && <span>📅 {a.due}</span>}
                            {a.priority && <span>⚡ {a.priority}</span>}
                            {a.status && <span>🔖 {a.status}</span>}
                          </div>
                        </div>
                        {a.assignee && <span class="action-assignee">{a.assignee}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {meeting.decisions.length > 0 && (
                <div class="summary-section">
                  <div class="summary-heading">🟢 Quyết định ({meeting.decisions.length})</div>
                  <div class="decisions">
                    {meeting.decisions.map((d, i) => (
                      <div class="decision-item" key={i}>
                        <div class="decision-text">{d}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {meeting.keywords && meeting.keywords.length > 0 && (
                <div class="summary-section">
                  <div class="summary-heading">🏷️ Từ khoá</div>
                  <div class="md-tags">
                    {meeting.keywords.map((k, i) => (
                      <span class="md-tag" key={i}>{k}</span>
                    ))}
                  </div>
                </div>
              )}
              <div class="summary-section" style={{ display: 'flex', gap: 8 }}>
                <button class="action-btn action-btn-primary" onClick={copySummaryMd}>
                  📋 Copy Markdown
                </button>
              </div>
            </div>
          ) : tab === 'merged-transcript' ? (
            <div class="tab-content active">
              {merging && (
                <div class="summary-section" style={{ background: '#eef6ff', border: '1px solid #b6dafd', padding: 12, borderRadius: 6, marginBottom: 12 }}>
                  <span class="spinner" /> <b>AI đang merge caption + audio…</b>
                </div>
              )}
              {mergedTranscript && mergedTranscript.lines.length > 0 ? (
                <div class="transcript-full">
                  {mergedTranscript.lines.map((entry, i) =>
                    isLine(entry) ? (
                      <div class="transcript-line transcript-source-audio" key={i}>
                        <div class="transcript-header">
                          <span class="speaker-chip">{entry.speaker}</span>
                          <span class="transcript-time">{fmtTime(entry.ts)}</span>
                          <span class="source-badge source-badge-audio">🔀 Merged</span>
                        </div>
                        <div class="transcript-text">{entry.text}</div>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', padding: 20 }}>
                  Chưa có merged transcript. Bấm nút "🔀 Merge (AI)" ở trên (cần đã có cả Caption transcript và Audio transcript).
                </p>
              )}
            </div>
          ) : tab === 'audio-transcript' ? (
            <div class="tab-content active">
              {transcribing && (
                <div class="summary-section" style={{ background: '#eef6ff', border: '1px solid #b6dafd', padding: 12, borderRadius: 6, marginBottom: 12 }}>
                  <span class="spinner" /> <b>Đang transcribe audio…</b> {transcribeMsg}
                </div>
              )}
              {audioTranscript && audioTranscript.lines.length > 0 ? (
                <div class="transcript-full">
                  {audioTranscript.lines.map((entry, i) =>
                    isLine(entry) ? (
                      <div class="transcript-line transcript-source-audio" key={i}>
                        <div class="transcript-header">
                          <span class="speaker-chip">{entry.speaker}</span>
                          <span class="transcript-time">{fmtTime(entry.ts)}</span>
                          <span class="source-badge source-badge-audio">🎙️ Audio</span>
                        </div>
                        <div class="transcript-text">{entry.text}</div>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', padding: 20 }}>
                  {meeting.audio?.hasInlineBlob
                    ? 'Chưa có audio transcript. Bấm nút "🎙️ Transcribe" ở trên để chuyển audio thành văn bản.'
                    : 'Meeting này không có file audio inline để transcribe.'}
                </p>
              )}
            </div>
          ) : tab === 'draft-email' ? (
            <div class="tab-content active">
              {meeting.draftEmail && (meeting.draftEmail.subject || meeting.draftEmail.body) ? (
                <div class="summary-section draft-email">
                  <div class="email-card">
                    {meeting.draftEmail.subject && (
                      <div class="email-row">
                        <span class="email-label">Tiêu đề:</span>
                        <span class="email-subject">{meeting.draftEmail.subject}</span>
                      </div>
                    )}
                    {meeting.draftEmail.body && (
                      <div class="email-body-wrap">
                        <div class="email-label">Nội dung:</div>
                        <pre class="email-body">{meeting.draftEmail.body}</pre>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button
                        class="action-btn action-btn-primary"
                        onClick={async () => {
                          const e = meeting.draftEmail!;
                          await navigator.clipboard.writeText(
                            `Subject: ${e.subject}\n\n${e.body}`,
                          );
                        }}
                      >
                        📋 Copy email
                      </button>
                      <a
                        class="action-btn action-btn-primary"
                        style={{ textDecoration: 'none', display: 'inline-block' }}
                        href={`mailto:?subject=${encodeURIComponent(meeting.draftEmail.subject)}&body=${encodeURIComponent(meeting.draftEmail.body)}`}
                      >
                        ✉️ Mở mail client
                      </a>
                    </div>
                  </div>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', padding: 20 }}>
                  Chưa có draft email. Chạy "✦ Tóm tắt" để AI sinh nội dung email.
                </p>
              )}
            </div>
          ) : (
            <div class="tab-content active">
              {(() => {
                const allLines = transcript?.lines ?? [];
                const sources = new Set<TranscriptSource>();
                for (const e of allLines) {
                  if (isLine(e)) sources.add(e.source ?? 'text');
                }
                const multi = sources.size > 1;
                const counts = { text: 0, audio: 0 };
                for (const e of allLines) {
                  if (isLine(e)) counts[e.source ?? 'text']++;
                }
                const visible = allLines.filter((e) => {
                  if (!isLine(e)) return sourceFilter === 'all';
                  if (sourceFilter === 'all') return true;
                  return (e.source ?? 'text') === sourceFilter;
                });
                return (
                  <>
                    {multi && (
                      <div class="transcript-source-filter">
                        <button
                          class={`filter-chip ${sourceFilter === 'all' ? 'active' : ''}`}
                          onClick={() => setSourceFilter('all')}
                        >
                          Tất cả ({counts.text + counts.audio})
                        </button>
                        <button
                          class={`filter-chip ${sourceFilter === 'text' ? 'active' : ''}`}
                          onClick={() => setSourceFilter('text')}
                        >
                          📝 Text ({counts.text})
                        </button>
                        <button
                          class={`filter-chip ${sourceFilter === 'audio' ? 'active' : ''}`}
                          onClick={() => setSourceFilter('audio')}
                        >
                          🎙️ Audio ({counts.audio})
                        </button>
                      </div>
                    )}
                    <div class="transcript-full">
                      {transcript ? (
                        visible.length === 0 ? (
                          <p style={{ color: 'var(--text-muted)' }}>
                            Không có dòng nào khớp bộ lọc.
                          </p>
                        ) : (
                          visible.map((entry, i) =>
                            isLine(entry) ? (
                              <div
                                class={`transcript-line transcript-source-${entry.source ?? 'text'}`}
                                key={i}
                              >
                                <div class="transcript-header">
                                  <span class="speaker-chip">{entry.speaker}</span>
                                  <span class="transcript-time">{fmtTime(entry.ts)}</span>
                                  {multi && (
                                    <span class={`source-badge source-badge-${entry.source ?? 'text'}`}>
                                      {(entry.source ?? 'text') === 'audio' ? '🎙️ Audio' : '📝 Text'}
                                    </span>
                                  )}
                                </div>
                                <div class="transcript-text">{entry.text}</div>
                              </div>
                            ) : (
                              <div
                                class="transcript-line"
                                key={i}
                                style={{ opacity: 0.6, fontStyle: 'italic' }}
                              >
                                ⏸ Capture đã tạm dừng: {fmtTime(entry.from)} → {fmtTime(entry.to)}
                              </div>
                            ),
                          )
                        )
                      ) : (
                        <p style={{ color: 'var(--text-muted)' }}>Đang tải transcript…</p>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </div>
    </>
  );
}

function ExportMenu({
  label,
  options,
}: {
  label: string;
  options: { label: string; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  // Close when clicking anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDocClick = () => setOpen(false);
    // Defer attach so the opening click doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', onDocClick);
    };
  }, [open]);
  return (
    <div class="export-menu" onClick={(e) => e.stopPropagation()}>
      <button
        class="action-btn action-btn-primary"
        onClick={() => setOpen((v) => !v)}
      >
        {label} <span style={{ marginLeft: 4, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div class="export-menu-list">
          {options.map((o, i) => (
            <button
              key={i}
              class="export-menu-item"
              onClick={() => {
                setOpen(false);
                o.onSelect();
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- PDF export ----------
// Render the summary HTML offscreen, rasterize with html2canvas, then place
// onto a multi-page A4 jsPDF. Skips the browser print dialog entirely so the
// user gets a direct download.
async function downloadSummaryPdf(
  meeting: MeetingRecord,
  safeName: string,
): Promise<void> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);

  const html = renderSummaryHtml(meeting, { forPrint: false });

  // Render inside an offscreen iframe so the PDF stylesheet (which uses
  // global selectors like `body`, `h1`, `p`, `ul`...) doesn't leak into
  // the host page and break the History UI mid-export.
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.left = '-99999px';
  iframe.style.top = '0';
  iframe.style.width = '794px';
  iframe.style.height = '2000px';
  iframe.style.border = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);
  await new Promise<void>((resolve, reject) => {
    iframe.onload = () => resolve();
    iframe.onerror = () => reject(new Error('iframe load failed'));
    iframe.srcdoc = html;
  });
  const idoc = iframe.contentDocument!;
  // Allow layout / web fonts a tick to settle before measuring.
  await new Promise((r) => setTimeout(r, 100));
  // Resize iframe to actual content height so html2canvas can capture it all.
  iframe.style.height = `${idoc.body.scrollHeight + 100}px`;
  await new Promise((r) => setTimeout(r, 50));
  const container = idoc.body;

  try {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const marginX = 14;
    const marginTop = 14;
    const marginBottom = 18;
    const imgWidth = pageWidth - marginX * 2;
    const usablePageHeight = pageHeight - marginTop - marginBottom;

    // Element-by-element rendering avoids the browser's canvas-size limit
    // (~16384px) that produces blank output for very long pages, and gives
    // natural page breaks between blocks instead of slicing mid-line.
    // Recurse into list/table containers so each item / row becomes its own
    // block — that way long lists don't get sliced through the middle of a
    // line of text.
    // Tags whose children should be unpacked so each leaf renders alone.
    // We also recurse into any DIV/SECTION that contains block-level
    // children (h*/p/ul/ol/table) — that's how we drill into the wrapping
    // <div class="summary-body"> which holds the full markdown output.
    const SPLITTABLE = new Set(['UL', 'OL', 'TBODY']);
    const BLOCK_CHILD_TAGS = new Set([
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'PRE',
    ]);
    const hasBlockChildren = (el: HTMLElement): boolean => {
      for (const c of Array.from(el.children)) {
        if (BLOCK_CHILD_TAGS.has(c.tagName)) return true;
      }
      return false;
    };
    const collectBlocks = (root: HTMLElement): HTMLElement[] => {
      const out: HTMLElement[] = [];
      for (const child of Array.from(root.children) as HTMLElement[]) {
        const isWrapperDiv =
          (child.tagName === 'DIV' || child.tagName === 'SECTION') &&
          hasBlockChildren(child);
        if (SPLITTABLE.has(child.tagName) || isWrapperDiv) {
          out.push(...collectBlocks(child));
        } else {
          out.push(child);
        }
      }
      return out;
    };
    const blocks = collectBlocks(container);
    let curY = marginTop;

    const placeCanvasSlices = async (canvas: HTMLCanvasElement) => {
      const w = imgWidth;
      const h = (canvas.height * w) / canvas.width;

      // Case 1: block fits within a single page → never slice. If the
      // remaining space on the current page is too small, start a new page
      // and place the block at the top.
      if (h <= usablePageHeight) {
        if (h > pageHeight - marginBottom - curY) {
          pdf.addPage();
          curY = marginTop;
        }
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', marginX, curY, w, h);
        curY += h + 2;
        return;
      }

      // Case 2: block is taller than a full page → slice unavoidable.
      let consumed = 0;
      const cw = canvas.width;
      const ch = canvas.height;
      const sliceCanvas = document.createElement('canvas');
      const sctx = sliceCanvas.getContext('2d')!;
      while (consumed < ch) {
        const remainingMm = pageHeight - marginBottom - curY;
        if (remainingMm < 10) {
          pdf.addPage();
          curY = marginTop;
        }
        const availableMm = pageHeight - marginBottom - curY;
        const slicePx = Math.min(ch - consumed, Math.floor((availableMm * cw) / w));
        sliceCanvas.width = cw;
        sliceCanvas.height = slicePx;
        sctx.fillStyle = '#ffffff';
        sctx.fillRect(0, 0, cw, slicePx);
        sctx.drawImage(canvas, 0, consumed, cw, slicePx, 0, 0, cw, slicePx);
        const sliceMm = (slicePx * w) / cw;
        pdf.addImage(sliceCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', marginX, curY, w, sliceMm);
        curY += sliceMm + 2;
        consumed += slicePx;
        if (consumed < ch) {
          pdf.addPage();
          curY = marginTop;
        }
      }
    };

    for (const el of blocks) {
      if (!el.offsetHeight) continue;
      const elCanvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
      });
      await placeCanvasSlices(elCanvas);
    }

    // Page numbers footer.
    // @ts-expect-error pdf.internal types are loose
    const totalPages: number = pdf.internal.pages.length - 1;
    for (let i = 1; i <= totalPages; i++) {
      pdf.setPage(i);
      pdf.setFontSize(9);
      pdf.setTextColor(107, 114, 128);
      pdf.text(`Trang ${i} / ${totalPages}`, pageWidth / 2, pageHeight - 8, {
        align: 'center',
      });
    }

    pdf.save(`${safeName}-summary.pdf`);
  } finally {
    iframe.remove();
  }
}

// ---------- DOCX export ----------
// Builds a real Office Open XML (.docx) file using the `docx` library so it
// opens cleanly in modern Word / Pages / Google Docs. Theme: deep-blue
// title/headings, soft lavender accent strip, light-blue meta block —
// mirrors the PDF export.
async function buildSummaryDocx(meeting: MeetingRecord): Promise<Blob> {
  const docx = await import('docx');
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    AlignmentType,
    BorderStyle,
    Table,
    TableRow,
    TableCell,
    WidthType,
    ShadingType,
    HeightRule,
    TableLayoutType,
  } = docx;
  const PRIMARY = '1D2EB6';        // deep blue
  const PRIMARY_LIGHT = 'E8EAFF';  // very light blue
  const ACCENT = 'A89BD9';         // lavender
  const TEXT = '111111';
  const MUTED = '6B7280';
  const ROW_ALT = 'F4F6FF';
  const DIVIDER = 'E5E7EB';

  // Inline markdown → docx TextRun[]. Handles **bold** segments.
  const inlineRuns = (
    text: string,
    base: { bold?: boolean; color?: string; size?: number } = {},
  ): InstanceType<typeof TextRun>[] => {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return parts.map((p) => {
      const bold = p.match(/^\*\*([^*]+)\*\*$/);
      if (bold) return new TextRun({ text: bold[1], bold: true, color: TEXT, ...base });
      const code = p.match(/^`([^`]+)`$/);
      if (code)
        return new TextRun({
          text: code[1],
          color: PRIMARY,
          font: 'Consolas',
          ...base,
        });
      return new TextRun({ text: p, ...base });
    });
  };

  const heading2 = (text: string) =>
    new Paragraph({
      children: [new TextRun({ text, bold: true, color: PRIMARY, size: 30 })],
      spacing: { before: 360, after: 140 },
      border: {
        bottom: { color: DIVIDER, size: 8, style: BorderStyle.SINGLE, space: 4 },
      },
    });

  const heading3 = (text: string) =>
    new Paragraph({
      children: [new TextRun({ text, bold: true, color: TEXT, size: 24 })],
      spacing: { before: 220, after: 80 },
    });

  const bullet = (text: string, level = 0) =>
    new Paragraph({
      children: inlineRuns(text, { size: 22 }),
      bullet: { level },
      spacing: { after: 80, line: 320 },
      indent: { left: 360 },
    });

  const para = (text: string) =>
    new Paragraph({
      children: inlineRuns(text, { size: 22 }),
      spacing: { after: 120, line: 320 },
      alignment: AlignmentType.JUSTIFIED,
    });

  // Convert the stored summary markdown to docx blocks.
  const summaryBlocks: InstanceType<typeof Paragraph>[] = [];
  if (meeting.summary) {
    const lines = meeting.summary.split('\n');
    let i = 0;
    let inList = false;
    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) {
        inList = false;
        i++;
        continue;
      }
      // Strip legacy @TAGS marker — keywords now have their own section below.
      if (/^@TAGS:/.test(line)) {
        i++;
        continue;
      }
      const h1M = line.match(/^#\s+(.+)$/);
      if (h1M) {
        summaryBlocks.push(
          new Paragraph({
            children: [
              new TextRun({ text: h1M[1], bold: true, color: TEXT, size: 40 }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 240 },
            border: { bottom: { color: PRIMARY, size: 18, style: BorderStyle.SINGLE, space: 6 } },
          }),
        );
        i++;
        continue;
      }
      const h2M = line.match(/^##\s+(.+)$/);
      if (h2M) {
        summaryBlocks.push(heading2(h2M[1]));
        i++;
        continue;
      }
      const h3M = line.match(/^###\s+(.+)$/);
      if (h3M) {
        summaryBlocks.push(heading3(h3M[1]));
        i++;
        continue;
      }
      const liM = line.match(/^[-*]\s+(.+)$/);
      if (liM) {
        summaryBlocks.push(bullet(liM[1], 0));
        inList = true;
        i++;
        continue;
      }
      summaryBlocks.push(para(line));
      inList = false;
      i++;
    }
  }

  // Action items table — header row deep blue/white, body rows alternate
  // shading, all cells with subtle blue borders + padding for readability.
  const cellBorder = {
    top: { color: DIVIDER, size: 4, style: BorderStyle.SINGLE },
    bottom: { color: DIVIDER, size: 4, style: BorderStyle.SINGLE },
    left: { color: DIVIDER, size: 4, style: BorderStyle.SINGLE },
    right: { color: DIVIDER, size: 4, style: BorderStyle.SINGLE },
  };
  const headerBorder = {
    top: { color: PRIMARY, size: 4, style: BorderStyle.SINGLE },
    bottom: { color: PRIMARY, size: 12, style: BorderStyle.SINGLE },
    left: { color: PRIMARY, size: 4, style: BorderStyle.SINGLE },
    right: { color: PRIMARY, size: 4, style: BorderStyle.SINGLE },
  };
  const cellPad = { top: 120, bottom: 120, left: 140, right: 140 };
  // Column widths in DXA. With layout=FIXED + table width matching the
  // sum, Word/Pages render columns at exactly these proportions.
  const COL_WIDTHS = [600, 3400, 1700, 1500, 1300, 1400]; // DXA, sum = 9900
  const COL_TOTAL = COL_WIDTHS.reduce((a, b) => a + b, 0);
  const headerCol = (
    label: string,
    idx: number,
  ): InstanceType<typeof TableCell> =>
    new TableCell({
      shading: { type: ShadingType.CLEAR, fill: PRIMARY, color: 'auto' },
      borders: headerBorder,
      margins: cellPad,
      width: { size: COL_WIDTHS[idx], type: WidthType.DXA },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: label, bold: true, color: 'FFFFFF', size: 22 }),
          ],
        }),
      ],
    });
  const bodyCell = (
    text: string,
    idx: number,
    opts: { center?: boolean; rowAlt?: boolean; bold?: boolean } = {},
  ): InstanceType<typeof TableCell> =>
    new TableCell({
      shading: opts.rowAlt
        ? { type: ShadingType.CLEAR, fill: ROW_ALT, color: 'auto' }
        : undefined,
      borders: cellBorder,
      margins: cellPad,
      width: { size: COL_WIDTHS[idx], type: WidthType.DXA },
      children: [
        new Paragraph({
          alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: inlineRuns(text || '—', { size: 20, bold: opts.bold }),
        }),
      ],
    });
  const actionTable: InstanceType<typeof Table> | null = meeting.actionItems.length
    ? new Table({
        columnWidths: COL_WIDTHS,
        layout: TableLayoutType.FIXED,
        width: { size: COL_TOTAL, type: WidthType.DXA },
        rows: [
          new TableRow({
            tableHeader: true,
            height: { value: 480, rule: HeightRule.ATLEAST },
            children: [
              headerCol('#', 0),
              headerCol('Công việc', 1),
              headerCol('Người phụ trách', 2),
              headerCol('Deadline', 3),
              headerCol('Ưu tiên', 4),
              headerCol('Trạng thái', 5),
            ],
          }),
          ...meeting.actionItems.map((a, i) => {
            const alt = i % 2 === 1;
            return new TableRow({
              children: [
                bodyCell(String(i + 1), 0, { center: true, rowAlt: alt, bold: true }),
                bodyCell(a.text, 1, { rowAlt: alt }),
                bodyCell(a.assignee ?? '—', 2, { rowAlt: alt }),
                bodyCell(a.due ?? '—', 3, { center: true, rowAlt: alt }),
                bodyCell(a.priority ?? '—', 4, { center: true, rowAlt: alt }),
                bodyCell(a.status ?? '—', 5, { center: true, rowAlt: alt }),
              ],
            });
          }),
        ],
      })
    : null;

  const date = new Date(meeting.createdAt).toLocaleString('vi-VN');
  const duration = `${Math.round(meeting.duration / 60)} phút`;

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  // Branding header (small caps, gray)
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: 'MEET ASSISTANT  •  MEETING NOTE',
          bold: true,
          size: 16,
          color: MUTED,
          characterSpacing: 30,
        }),
      ],
      spacing: { after: 80 },
      border: {
        bottom: { color: DIVIDER, size: 4, style: BorderStyle.SINGLE, space: 6 },
      },
    }),
  );
  // Title — big uppercase deep blue with thick blue underline
  children.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({
          text: meeting.title.toUpperCase(),
          bold: true,
          color: PRIMARY,
          size: 44,
        }),
      ],
      spacing: { before: 240, after: 100 },
      border: {
        bottom: { color: PRIMARY, size: 18, style: BorderStyle.SINGLE, space: 6 },
      },
    }),
  );
  // Meta block — bordered + shaded panel (uses a 1-cell table for full
  // background fill, since paragraph shading in Word only colors the text line).
  // Same width handling as the action-items table: DXA + FIXED layout, since
  // percentage widths get collapsed by some Word/Pages versions.
  children.push(
    new Table({
      columnWidths: [COL_TOTAL],
      layout: TableLayoutType.FIXED,
      width: { size: COL_TOTAL, type: WidthType.DXA },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.CLEAR, fill: PRIMARY_LIGHT, color: 'auto' },
              width: { size: COL_TOTAL, type: WidthType.DXA },
              borders: {
                top: { color: PRIMARY_LIGHT, size: 4, style: BorderStyle.SINGLE },
                bottom: { color: PRIMARY_LIGHT, size: 4, style: BorderStyle.SINGLE },
                left: { color: PRIMARY, size: 24, style: BorderStyle.SINGLE },
                right: { color: PRIMARY_LIGHT, size: 4, style: BorderStyle.SINGLE },
              },
              margins: { top: 160, bottom: 160, left: 200, right: 200 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: 'Ngày: ', bold: true, color: PRIMARY, size: 22 }),
                    new TextRun({ text: date, size: 22, color: TEXT }),
                    new TextRun({ text: '          ', size: 22 }),
                    new TextRun({ text: 'Thời lượng: ', bold: true, color: PRIMARY, size: 22 }),
                    new TextRun({ text: duration, size: 22, color: TEXT }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  );
  // Spacer
  children.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 160 } }));

  // Summary blocks (markdown content)
  children.push(...summaryBlocks);

  // Action items
  if (actionTable) {
    children.push(heading2('Đầu việc & người phụ trách'));
    children.push(actionTable);
    children.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 160 } }));
  }
  // Decisions
  if (meeting.decisions.length) {
    children.push(heading2('Quyết định'));
    for (const d of meeting.decisions) children.push(bullet(d));
  }
  // Pending issues
  if (meeting.pendingIssues.length) {
    children.push(heading2('Vấn đề tồn đọng / Rủi ro'));
    for (const p of meeting.pendingIssues) children.push(bullet(p));
  }
  // Keywords — pill-style shaded runs separated by spaces.
  if (meeting.keywords?.length) {
    children.push(heading2('Từ khoá'));
    children.push(
      new Paragraph({
        children: meeting.keywords.flatMap((t, idx) => {
          const sep =
            idx < meeting.keywords!.length - 1
              ? [new TextRun({ text: '   ', size: 20 })]
              : [];
          return [
            new TextRun({
              text: `  ${t}  `,
              color: PRIMARY,
              bold: true,
              shading: { type: ShadingType.CLEAR, fill: PRIMARY_LIGHT, color: 'auto' },
              size: 20,
            }),
            ...sep,
          ];
        }),
        spacing: { after: 200, line: 360 },
      }),
    );
  }

  // Footer — small gray credit line.
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: 'Meet Assistant · Tài liệu được sinh tự động',
          color: MUTED,
          size: 16,
          italics: true,
        }),
      ],
      spacing: { before: 480 },
      border: {
        top: { color: DIVIDER, size: 4, style: BorderStyle.SINGLE, space: 6 },
      },
    }),
  );

  const doc = new Document({
    creator: 'Meet Assistant',
    title: meeting.title,
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
        },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } },
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Markdown for the Summary tab clipboard copy. Excludes draft email + transcript.
function renderSummaryMarkdown(meeting: MeetingRecord): string {
  const parts: string[] = [];
  parts.push(`# ${meeting.title}\n`);
  parts.push(`**Ngày:** ${new Date(meeting.createdAt).toLocaleString('vi-VN')}  `);
  parts.push(`**Thời lượng:** ${Math.round(meeting.duration / 60)} phút\n`);
  if (meeting.summary) parts.push(`${meeting.summary}\n`);
  if (meeting.actionItems.length) {
    parts.push(`## Đầu việc & người phụ trách\n`);
    for (const a of meeting.actionItems) {
      const meta = [a.assignee && `👤 ${a.assignee}`, a.due && `📅 ${a.due}`, a.priority && `⚡ ${a.priority}`, a.status && `🔖 ${a.status}`]
        .filter(Boolean)
        .join(' · ');
      parts.push(`- [ ] ${a.text}${meta ? ` — ${meta}` : ''}`);
    }
    parts.push('');
  }
  if (meeting.decisions.length) {
    parts.push(`## Quyết định\n`);
    for (const d of meeting.decisions) parts.push(`- ${d}`);
    parts.push('');
  }
  if (meeting.pendingIssues.length) {
    parts.push(`## Vấn đề tồn đọng\n`);
    for (const p of meeting.pendingIssues) parts.push(`- ${p}`);
    parts.push('');
  }
  if (meeting.keywords?.length) {
    parts.push(`**Từ khoá:** ${meeting.keywords.map((k) => `\`${k}\``).join(' ')}\n`);
  }
  return parts.join('\n');
}

function renderTranscriptMarkdown(meeting: MeetingRecord, transcript: TranscriptRecord | null): string {
  const parts: string[] = [];
  parts.push(`# ${meeting.title} — Transcript\n`);
  parts.push(`**Ngày:** ${new Date(meeting.createdAt).toLocaleString('vi-VN')}\n`);
  if (transcript?.lines.length) {
    for (const e of transcript.lines) {
      if (isLine(e)) {
        parts.push(`**${e.speaker}** _(${fmtTime(e.ts)})_: ${e.text}\n`);
      } else {
        parts.push(`> _Paused: ${fmtTime(e.from)} → ${fmtTime(e.to)}_\n`);
      }
    }
  } else {
    parts.push('_Không có transcript._');
  }
  return parts.join('\n');
}

// HTML for Summary export (PDF print + Word .doc). No draft email, no transcript.
function renderSummaryHtml(
  meeting: MeetingRecord,
  opts: { forPrint: boolean },
): string {
  const escape = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const date = new Date(meeting.createdAt).toLocaleString('vi-VN');
  const duration = `${Math.round(meeting.duration / 60)} phút`;

  const summaryHtml = meeting.summary ? mdToHtml(meeting.summary) : '';

  const actionsHtml = meeting.actionItems.length
    ? `<h2>Đầu việc &amp; người phụ trách</h2>
<table>
<thead><tr>
<th style="width:36px">#</th>
<th>Công việc</th>
<th>Người phụ trách</th>
<th>Deadline</th>
<th>Ưu tiên</th>
<th>Trạng thái</th>
</tr></thead>
<tbody>
${meeting.actionItems
  .map(
    (a, i) => `<tr>
<td>${i + 1}</td>
<td>${escape(a.text)}</td>
<td>${escape(a.assignee ?? '-')}</td>
<td>${escape(a.due ?? '-')}</td>
<td>${escape(a.priority ?? '-')}</td>
<td>${escape(a.status ?? '-')}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>`
    : '';

  const decisionsHtml = meeting.decisions.length
    ? `<h2>Quyết định</h2><ul>${meeting.decisions
        .map((d) => `<li>${escape(d)}</li>`)
        .join('')}</ul>`
    : '';

  const pendingHtml = meeting.pendingIssues.length
    ? `<h2>Vấn đề tồn đọng / Rủi ro</h2><ul>${meeting.pendingIssues
        .map((p) => `<li>${escape(p)}</li>`)
        .join('')}</ul>`
    : '';

  const keywordsHtml = meeting.keywords?.length
    ? `<h2>Từ khoá</h2><div class="tags">${meeting.keywords
        .map((k) => `<span class="tag">${escape(k)}</span>`)
        .join(' ')}</div>`
    : '';

  // Blue/purple theme inspired by the user's reference template.
  const PRIMARY = '#1d2eb6'; // deep blue (matches "BIÊN BẢN CUỘC HỌP" headline)
  const PRIMARY_LIGHT = '#e8eaff';
  const ACCENT = '#a89bd9'; // lavender side strip
  const DIVIDER = '#e5e7eb';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>${escape(meeting.title)} — Tóm tắt</title>
<style>
  @page { size: A4; margin: 22mm 18mm 22mm 18mm; }
  html { background: white; }
  body {
    font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: #1f2937; line-height: 1.6; font-size: 13px;
    max-width: 820px; margin: 0 auto;
    padding: 24px 24px 24px 36px;
    border-left: 8px solid ${ACCENT};
    position: relative;
  }
  .doc-header {
    text-align: right;
    font-weight: 600; font-size: 11px;
    color: ${PRIMARY};
    letter-spacing: 0.5px;
    padding-bottom: 6px;
    margin-bottom: 16px;
    border-bottom: 1px solid ${DIVIDER};
  }
  h1 {
    font-size: 28px; font-weight: 800;
    color: ${PRIMARY};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 8px 0 8px;
    line-height: 1.15;
  }
  h2 {
    font-size: 17px; font-weight: 700;
    color: ${PRIMARY};
    margin: 26px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid ${DIVIDER};
  }
  h3 {
    font-size: 14px; font-weight: 700;
    color: #111;
    margin: 14px 0 6px;
  }
  h4 { font-size: 13px; font-weight: 600; color: #1f2937; margin: 12px 0 4px; }
  p { margin: 6px 0; }
  ul, ol { padding-left: 22px; margin: 8px 0; }
  ul { list-style-type: disc; }
  ul ul { list-style-type: circle; margin: 4px 0; }
  li { margin: 4px 0; }
  strong { color: #111; }
  table {
    width: 100%; border-collapse: collapse; margin: 8px 0;
    font-size: 12px;
  }
  th, td {
    border: 1px solid ${DIVIDER}; padding: 8px 10px;
    text-align: left; vertical-align: top;
  }
  th {
    background: ${PRIMARY_LIGHT}; color: ${PRIMARY};
    font-weight: 700; font-size: 12px;
    border-bottom: 2px solid ${PRIMARY};
  }
  tbody tr:nth-child(even) { background: #f8f9ff; }
  .meta {
    background: ${PRIMARY_LIGHT};
    border-left: 4px solid ${PRIMARY};
    padding: 10px 14px;
    margin: 4px 0 22px;
    font-size: 12px;
    border-radius: 0 4px 4px 0;
    color: #374151;
  }
  .meta strong { color: ${PRIMARY}; }
  .meta-row { display: flex; gap: 16px; flex-wrap: wrap; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .tag {
    display: inline-block; padding: 4px 12px;
    background: ${PRIMARY_LIGHT}; color: ${PRIMARY};
    border-radius: 999px; font-size: 11px;
    border: 1px solid #c7cdf8;
    font-weight: 500;
  }
  code, .md-tag {
    background: ${PRIMARY_LIGHT}; color: ${PRIMARY};
    padding: 2px 6px; border-radius: 4px;
    font-family: ui-monospace, "Courier New", monospace;
    font-size: 12px;
    border: 1px solid #c7cdf8;
  }
  .md-h1 { font-size: 22px; font-weight: 800; color: ${PRIMARY}; text-transform: uppercase; margin: 0 0 12px; padding-bottom: 10px; border-bottom: 2px solid ${DIVIDER}; }
  .md-h2 { font-size: 17px; font-weight: 700; color: ${PRIMARY}; border-bottom: 1px solid ${DIVIDER}; padding-bottom: 6px; margin: 24px 0 10px; }
  .md-h3 { font-size: 14px; font-weight: 700; margin: 12px 0 6px; }
  .md-list { padding-left: 22px; margin: 6px 0; }
  .md-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  ${
    opts.forPrint
      ? `
  @media print {
    body { padding: 0; }
    .doc-header { position: running(header); }
    .doc-footer { position: running(footer); display: block; text-align: center; font-size: 10px; color: #6b7280; }
    @page { @top-center { content: element(header); } @bottom-center { content: counter(page) " / " counter(pages); font-size: 10px; color: #6b7280; } }
    h1, h2, h3 { page-break-after: avoid; }
    tr, li { page-break-inside: avoid; }
    table { page-break-inside: auto; }
  }
  `
      : ''
  }
</style>
</head>
<body>
<div class="doc-header">MEET ASSISTANT • MEETING NOTE</div>
<h1>${escape(meeting.title)}</h1>
<div class="meta">
  <div class="meta-row">
    <span><strong>Ngày:</strong> ${escape(date)}</span>
    <span><strong>Thời lượng:</strong> ${escape(duration)}</span>
  </div>
</div>
${summaryHtml ? `<div class="summary-body">${summaryHtml}</div>` : ''}
${actionsHtml}
${decisionsHtml}
${pendingHtml}
${keywordsHtml}
${
  opts.forPrint
    ? `<script>window.addEventListener('afterprint', () => window.close());</script>`
    : ''
}
</body>`;
}

