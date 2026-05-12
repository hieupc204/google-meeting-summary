import { DEFAULT_DRAFT_EMAIL_LABELS, DEFAULT_SYSTEM_PROMPT } from './constants';
import type {
  ActionItem,
  DraftEmail,
  MeetingRecord,
  TranscriptEntry,
  TranscriptLine,
  TranscriptRecord,
  UserSettings,
} from './types';

export interface SummaryResult {
  summary: string;
  actionItems: ActionItem[];
  decisions: string[];
  pendingIssues: string[];
  draftEmail?: DraftEmail;
  keywords?: string[];
}

function isLine(e: TranscriptEntry): e is TranscriptLine {
  return (e as TranscriptLine).hash !== undefined;
}

function transcriptToText(t: TranscriptRecord | undefined | null): string {
  if (!t) return '';
  return t.lines
    .filter(isLine)
    .map((l) => `${l.speaker}: ${l.text}`)
    .join('\n');
}

const TRANSCRIPT_PLACEHOLDER_RE = /\{\{\s*TRANSCRIPT(?:_HERE)?\s*\}\}/g;
const TITLE_PLACEHOLDER_RE = /\{\{\s*TITLE\s*\}\}/g;
const DATE_PLACEHOLDER_RE = /\{\{\s*DATE\s*\}\}/g;

function fillPlaceholders(
  template: string,
  meeting: MeetingRecord,
  text: string,
  settings?: UserSettings,
): string {
  const labels = {
    ...DEFAULT_DRAFT_EMAIL_LABELS,
    ...(settings?.summary.draftEmailLabels ?? {}),
  };
  return template
    .replace(TRANSCRIPT_PLACEHOLDER_RE, text)
    .replace(TITLE_PLACEHOLDER_RE, meeting.title)
    .replace(DATE_PLACEHOLDER_RE, new Date(meeting.createdAt).toISOString())
    .replace(/\{\{\s*LABEL_KET_QUA_CHINH\s*\}\}/g, labels.ketQuaChinh)
    .replace(/\{\{\s*LABEL_NOI_DUNG_THONG_NHAT\s*\}\}/g, labels.noiDungThongNhat)
    .replace(/\{\{\s*LABEL_ACTION_ITEMS\s*\}\}/g, labels.actionItems)
    .replace(/\{\{\s*LABEL_RUI_RO\s*\}\}/g, labels.ruiRo)
    .replace(/\{\{\s*LABEL_BUOC_TIEP_THEO\s*\}\}/g, labels.buocTiepTheo);
}

function buildSystemPrompt(s: UserSettings): string {
  if (s.summary.customSystemPrompt) return s.summary.customSystemPrompt;
  const lang =
    s.language === 'vi' ? 'Vietnamese' : s.language === 'en' ? 'English' : 'the language of the transcript';
  const parts: string[] = [];
  parts.push(
    `You are a meeting assistant. Read the meeting transcript provided by the user and produce a structured summary.`,
  );
  parts.push(`Output language: ${lang}.`);
  parts.push(
    `Return ONLY a single JSON object with the following keys (no surrounding markdown, no commentary):`,
  );
  const fields: string[] = [];
  if (s.summary.includeMeetingInfo)
    fields.push(
      `"meetingInfo": { "name"?: string, "time"?: string, "participants"?: string[], "objective"?: string }`,
    );
  if (s.summary.includeSummary) fields.push(`"summary": string — concise overview, 3-6 sentences`);
  if (s.summary.includeDiscussionTopics)
    fields.push(`"discussionTopics": array of string — main topics discussed`);
  if (s.summary.includeKeyOpinions)
    fields.push(`"keyOpinions": array of string — important opinions raised`);
  if (s.summary.includeActionItems)
    fields.push(
      `"actionItems": array of { "text": string, "assignee"?: string, "due"?: string, "priority"?: string, "status"?: string }`,
    );
  if (s.summary.includeDecisions) fields.push(`"decisions": array of string`);
  if (s.summary.includePendingIssues) fields.push(`"pendingIssues": array of string`);
  if (s.summary.includeNextSteps) fields.push(`"nextSteps": array of string`);
  if (s.summary.includeKeyQuotes) fields.push(`"keyQuotes": array of string`);
  if (s.summary.includeDraftEmail)
    fields.push(`"draftEmail": { "subject": string, "body": string }`);
  parts.push(fields.map((f) => `- ${f}`).join('\n'));
  parts.push(`If a section has no content, return an empty string or empty array.`);
  return parts.join('\n\n');
}

function extractJson(raw: string): unknown {
  // Strip ```json fences if present.
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try to locate the first balanced {...} block.
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        // fall through
      }
    }
    throw new Error(
      `AI không trả về JSON hợp lệ. Nội dung trả về: "${trimmed.slice(0, 300)}${trimmed.length > 300 ? '…' : ''}". Hãy đảm bảo system prompt yêu cầu AI trả về JSON object duy nhất, không kèm giải thích.`,
    );
  }
}

// Walk an object/array tree and return the first value whose key matches any
// of the provided aliases (case-insensitive). Used so we can accept many
// different schema conventions (English, Vietnamese, snake_case, etc.).
function findByKey(node: unknown, aliases: string[]): unknown {
  const keyset = new Set(aliases.map((k) => k.toLowerCase()));
  const visit = (n: unknown): unknown => {
    if (!n || typeof n !== 'object') return undefined;
    if (Array.isArray(n)) {
      for (const item of n) {
        const r = visit(item);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    const o = n as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (keyset.has(k.toLowerCase())) return v;
    }
    for (const v of Object.values(o)) {
      const r = visit(v);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return visit(node);
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(asString).filter(Boolean).join('\n');
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map(asString).filter(Boolean).join('\n');
  return String(v);
}

const KEY_LABELS: Record<string, string> = {
  // meetingInfo
  ten_cuoc_hop: 'Tên cuộc họp',
  name: 'Tên cuộc họp',
  title: 'Tên cuộc họp',
  ngay_hop: 'Ngày họp',
  thoi_gian: 'Thời gian',
  time: 'Thời gian',
  date: 'Ngày',
  hinh_thuc: 'Hình thức',
  thanh_phan_tham_gia: 'Thành phần tham gia',
  participants: 'Thành phần tham gia',
  attendees: 'Thành phần tham gia',
  nguoi_chu_tri: 'Người chủ trì',
  chair: 'Người chủ trì',
  muc_tieu_cuoc_hop: 'Mục tiêu cuộc họp',
  muc_tieu: 'Mục tiêu',
  objective: 'Mục tiêu',
  // discussion sub-fields
  noi_dung_trao_doi: 'Nội dung trao đổi',
  y_kien_noi_bat: 'Ý kiến nổi bật',
  van_de_gap_phai: 'Vấn đề gặp phải',
  giai_phap_de_xuat: 'Giải pháp đề xuất',
  ket_luan: 'Kết luận',
  // risk sub-fields
  noi_dung: 'Nội dung',
  huong_xu_ly: 'Hướng xử lý',
  // generic
  subject: 'Tiêu đề',
  body: 'Nội dung',
};

function labelKey(k: string): string {
  return (
    KEY_LABELS[k] ??
    k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function asStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v))
    return v.map((x) => (typeof x === 'string' ? x : asString(x))).filter(Boolean);
  if (typeof v === 'string') return [v];
  return [];
}

function normalizeResult(parsed: unknown): SummaryResult {
  // Note: executive_summary is intentionally NOT shown at the top — the
  // discussion topics / decisions / action items sections below cover the
  // same ground in a more structured way. We only fall back to it later
  // (in the "no other content" empty-state branch).
  const rawExecSummary = asString(
    findByKey(parsed, [
      'executive_summary',
      'executiveSummary',
      'summary',
      'tomtat',
      'tom_tat',
      'tom_tat_noi_dung',
      'overview',
      'tong_ket',
      'tong_ket_ngan_gon',
    ]),
  );

  // Top-level: only the meeting title as h1, no leading summary paragraph.
  const meetingName = asString(
    findByKey(parsed, ['ten_cuoc_hop', 'meeting_title', 'meetingTitle']),
  );
  let summary = meetingName ? `# ${meetingName}` : '';

  // Optional rich sections — append into summary text so they appear in UI
  // without needing a new schema. Each section gets a Markdown heading.
  const sections: { title: string; aliases: string[]; renderArray?: boolean }[] = [
    {
      title: 'Thông tin cuộc họp',
      aliases: ['meetingInfo', 'thong_tin_cuoc_hop', 'thong_tin_chung', 'meeting_info'],
    },
    {
      title: 'Các chủ đề được thảo luận',
      aliases: [
        'discussionTopics',
        'discussion_topics',
        'tong_hop_van_de_da_trao_doi',
        'cac_chu_de_thao_luan',
        'cac_chu_de_duoc_thao_luan',
        'topics',
      ],
      renderArray: true,
    },
    {
      title: 'Ý kiến quan trọng',
      aliases: ['keyOpinions', 'key_opinions', 'y_kien_quan_trong'],
      renderArray: true,
    },
    {
      title: 'Rủi ro & Blocker',
      aliases: ['rui_ro_blocker', 'risks', 'blockers', 'rui_ro', 'kho_khan_rui_ro_duoc_de_cap'],
      renderArray: true,
    },
    {
      title: 'Các bước tiếp theo',
      aliases: ['nextSteps', 'next_steps', 'cac_buoc_tiep_theo'],
      renderArray: true,
    },
    {
      title: 'Key Quotes',
      aliases: ['keyQuotes', 'key_quotes', 'trich_dan'],
      renderArray: true,
    },
  ];
  const extras: string[] = [];
  for (const sec of sections) {
    const v = findByKey(parsed, sec.aliases);
    if (v == null) continue;
    if (sec.renderArray && Array.isArray(v)) {
      // Object array — typically nested topics with sub-bullets, or decisions
      // with priority emoji, or risks with mitigation.
      if (v.length > 0 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
        const blocks: string[] = [];
        for (const item of v) {
          const o = item as Record<string, unknown>;
          const heading = asString(
            o.ten_chu_de ?? o.title ?? o.name ?? o.heading ?? o.chu_de,
          );
          // Detailed sub-fields used by the rich default prompt.
          const subFields: { label: string; value: unknown }[] = [
            { label: 'Nội dung trao đổi', value: o.noi_dung_trao_doi ?? o.discussion },
            { label: 'Ý kiến nổi bật', value: o.y_kien_noi_bat ?? o.key_opinions },
            { label: 'Vấn đề gặp phải', value: o.van_de_gap_phai ?? o.issues },
            { label: 'Giải pháp đề xuất', value: o.giai_phap_de_xuat ?? o.solutions },
            { label: 'Kết luận', value: o.ket_luan ?? o.conclusion },
            // Risk-specific
            { label: 'Hướng xử lý', value: o.huong_xu_ly ?? o.mitigation },
          ];
          const subParts: string[] = [];
          for (const f of subFields) {
            if (f.value == null) continue;
            if (Array.isArray(f.value)) {
              const arr = f.value.map(asString).filter(Boolean);
              if (arr.length) subParts.push(`**${f.label}:**\n${arr.map((b) => `- ${b}`).join('\n')}`);
            } else {
              const s = asString(f.value).trim();
              if (s) subParts.push(`**${f.label}:** ${s}`);
            }
          }
          // Generic bullets (legacy schema).
          const genericBullets = asStringArray(
            o.noi_dung ?? o.content ?? o.points ?? o.items ?? o.bullets,
          );
          // Decision priority emoji.
          const mucDo = asString(o.muc_do ?? o.priority ?? '').trim();
          // Decision text fallback.
          const decisionText = asString(o.decision ?? '');

          let body = '';
          if (subParts.length) body = subParts.join('\n\n');
          else if (genericBullets.length) body = genericBullets.map((b) => `- ${b}`).join('\n');
          else if (mucDo || decisionText) body = `${mucDo ? mucDo + ' ' : ''}${decisionText || asString(o.noi_dung ?? '')}`.trim();
          else if (o.noi_dung) body = asString(o.noi_dung);
          else body = asString(o);

          const head = heading ? `### ${heading}` : '';
          if (head || body) blocks.push([head, body].filter(Boolean).join('\n'));
        }
        if (blocks.length) extras.push(`## ${sec.title}\n${blocks.join('\n\n')}`);
        continue;
      }
      const items = v.map(asString).filter(Boolean);
      if (items.length === 0) continue;
      extras.push(`## ${sec.title}\n${items.map((x) => `- ${x}`).join('\n')}`);
    } else if (typeof v === 'string') {
      if (v.trim()) extras.push(`## ${sec.title}\n${v}`);
    } else if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // For draftEmail: try subject + body.
      if (o.subject || o.body) {
        const subject = asString(o.subject);
        const body = asString(o.body);
        extras.push(
          `## ${sec.title}\n**Subject:** ${subject}\n\n${body}`,
        );
      } else {
        // Skip content-like keys that duplicate other sections (e.g. AI may
        // emit "noi_dung" inside meetingInfo, but that overlaps with the
        // discussion topics section below).
        const skipKeys = new Set([
          'noi_dung',
          'content',
          'description',
          'tom_tat',
          'tom_tat_noi_dung',
          'summary',
          'overview',
        ]);
        const lines = Object.entries(o)
          .filter(([k, val]) => !skipKeys.has(k.toLowerCase()) && val != null && asString(val).trim())
          .map(([k, val]) => `- **${labelKey(k)}**: ${asString(val)}`)
          .join('\n');
        if (lines.trim()) extras.push(`## ${sec.title}\n${lines}`);
      }
    }
  }
  if (extras.length) {
    summary = [summary, ...extras].filter(Boolean).join('\n\n');
  }

  const actionsRaw = findByKey(parsed, [
    'actionItems',
    'action_items',
    'cong_viec_can_thuc_hien',
    'tasks',
    'cong_viec',
    'dau_viec',
  ]);
  const actionItems: ActionItem[] = Array.isArray(actionsRaw)
    ? actionsRaw
        .map((x) => {
          if (typeof x === 'string') return { text: x };
          const a = (x ?? {}) as Record<string, unknown>;
          let text = asString(a.text ?? a.cong_viec ?? a.task ?? a.title ?? a.description);
          const note = asString(a.ghi_chu ?? a.note ?? a.notes ?? '');
          if (note) text = `${text} (${note})`;
          const assignee = a.assignee ?? a.nguoi_phu_trach ?? a.owner;
          const due = a.due ?? a.deadline ?? a.deadline_date;
          const priority = a.priority ?? a.muc_do_uu_tien ?? a.uu_tien;
          const status = a.status ?? a.trang_thai;
          return {
            text,
            assignee: assignee ? String(assignee) : undefined,
            due: due ? String(due) : undefined,
            priority: priority ? String(priority) : undefined,
            status: status ? String(status) : undefined,
          };
        })
        .filter((a) => a.text)
    : [];
  const decisionsRaw = findByKey(parsed, [
    'decisions',
    'quyet_dinh',
    'quyet_dinh_quan_trong',
    'cac_quyet_dinh',
    'cac_quyet_dinh_da_thong_nhat',
  ]);
  const decisions: string[] = Array.isArray(decisionsRaw)
    ? decisionsRaw
        .map((x) => {
          if (typeof x === 'string') return x;
          const o = (x ?? {}) as Record<string, unknown>;
          const text = asString(o.noi_dung ?? o.text ?? o.decision ?? o.content);
          const mucDo = asString(o.muc_do ?? o.priority ?? '').trim();
          return [mucDo, text].filter(Boolean).join(' ');
        })
        .filter(Boolean)
    : [];
  const pendingIssues = asStringArray(
    findByKey(parsed, [
      'pendingIssues',
      'pending_issues',
      'rui_ro',
      'kho_khan',
      'kho_khan_rui_ro_duoc_de_cap',
      'issues',
    ]),
  );

  // Draft email — stored separately, not embedded into summary text.
  let draftEmail: DraftEmail | undefined;
  const draftRaw = findByKey(parsed, [
    'draftEmail',
    'draft_email_gui_quan_ly',
    'draft_email',
  ]);
  if (draftRaw && typeof draftRaw === 'object' && !Array.isArray(draftRaw)) {
    const o = draftRaw as Record<string, unknown>;
    const subject = asString(o.subject ?? o.tieu_de ?? o.title);
    const body = asString(o.body ?? o.noi_dung ?? o.content);
    if (subject || body) draftEmail = { subject, body };
  }

  // Keywords — stored as separate array; rendered as tag pills in UI.
  const keywordsRaw = findByKey(parsed, ['keywords', 'tu_khoa', 'tags']);
  let keywords: string[] = [];
  if (Array.isArray(keywordsRaw)) {
    keywords = keywordsRaw.map(asString).map((s) => s.trim()).filter(Boolean);
  } else if (typeof keywordsRaw === 'string') {
    // AI sometimes returns tu_khoa as a single string. Split on common
    // separators (comma, semicolon, pipe, bullet, newline) and trim.
    keywords = keywordsRaw
      .split(/[,;|•·\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // If still got 1 huge concatenated string (no separators found), try
  // splitting on capital-letter boundaries — but only if it really looks
  // like camel-/PascalCase joined words.
  if (keywords.length === 1 && keywords[0].length > 60 && /[a-z][A-Z]/.test(keywords[0])) {
    keywords = keywords[0]
      .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 1);
  }

  // Some models add a "## Từ khoá" / "## Keywords" section inside the
  // summary text in addition to (or instead of) the tu_khoa field.
  // Strip it from summary text so the dedicated tag-pill section is the
  // single source of truth — and capture content into keywords[] if the
  // dedicated field was missing.
  const tuKhoaHeadingRe =
    /^##\s*(?:🏷️\s*)?(?:Từ\s*khoá?|Keywords?|Tags?)\s*\n([\s\S]*?)(?=\n##\s|$)/im;
  const m = summary.match(tuKhoaHeadingRe);
  if (m) {
    summary = summary.replace(tuKhoaHeadingRe, '').trim();
    if (keywords.length === 0) {
      keywords = m[1]
        .split(/[,;|•·\n]+|\s{2,}/)
        .map((s) => s.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean);
    }
  }

  if (!summary && actionItems.length === 0 && decisions.length === 0 && pendingIssues.length === 0 && !draftEmail) {
    // Worst case: AI returned only an executive summary or only unrecognized
    // shape. Show whatever we have so the user isn't staring at nothing.
    return {
      summary: rawExecSummary || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)),
      actionItems: [],
      decisions: [],
      pendingIssues: [],
    };
  }

  return { summary, actionItems, decisions, pendingIssues, draftEmail, keywords };
}

// Threshold for chunking. ~60k chars ≈ 15k tokens — within most context windows
// even with the rich prompt template included.
const SINGLE_SHOT_MAX_CHARS = 60_000;
const CHUNK_CHARS = 30_000;

// Split transcript text into chunks, breaking on newlines so speakers stay
// intact. Each chunk is at most chunkChars characters.
function splitTranscript(text: string, chunkChars: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur.length + line.length + 1 > chunkChars && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Map step: turn a transcript chunk into a compact intermediate summary
// (markdown text, not JSON). Cheaper + lower latency per call.
async function summarizeChunk(
  chunkText: string,
  idx: number,
  total: number,
  settings: UserSettings,
): Promise<string> {
  const sys = `Bạn đang tóm tắt phần ${idx}/${total} của một transcript cuộc họp dài.

Hãy tạo bản tóm tắt 200-500 từ bằng tiếng Việt cho riêng phần này, gồm các mục:
- **Chủ đề trao đổi**: các nội dung chính được bàn trong đoạn này
- **Ý kiến nổi bật / tranh luận**: ai nói gì quan trọng
- **Quyết định đã chốt** (nếu có)
- **Action items**: việc cần làm + người phụ trách + deadline (nếu có)
- **Rủi ro / blocker** được nêu

YÊU CẦU:
- Văn phong chuyên nghiệp, dễ đọc.
- Giữ tên riêng và thuật ngữ kỹ thuật.
- Loại bỏ small talk, lặp lại.
- Output dạng markdown có heading + bullet, KHÔNG cần bọc JSON.`;

  const messages = [
    { role: 'system' as const, content: sys },
    { role: 'user' as const, content: `Transcript phần ${idx}/${total}:\n\n${chunkText}` },
  ];
  const raw = await callChatAPI(messages, settings);
  return raw.trim();
}

// Low-level chat call. Returns raw assistant content text.
async function callChatAPI(
  messages: { role: 'system' | 'user'; content: string }[],
  settings: UserSettings,
): Promise<string> {
  const url = `${settings.ai.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.ai.model,
        messages,
        temperature: 0.2,
        // Stream so the response is delivered token-by-token. Without this,
        // proxies like Cloudflare cut the connection (524) when generation
        // exceeds their idle timeout (~100s). parseChatCompletion already
        // handles SSE-format response below.
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError')
      throw new Error('AI request timed out (>5 phút).');
    throw new Error(`Fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI API ${res.status}: ${body.slice(0, 300)}`);
  }
  const raw = await res.text();
  return parseChatCompletion(raw);
}

export async function summarizeMeeting(
  meeting: MeetingRecord,
  transcript: TranscriptRecord | null | undefined,
  settings: UserSettings,
): Promise<SummaryResult> {
  if (!settings.ai.endpoint) throw new Error('Chưa cấu hình AI endpoint');
  if (!settings.ai.apiKey) throw new Error('Chưa cấu hình API key');
  const text = transcriptToText(transcript);
  if (!text.trim()) throw new Error('Transcript trống');

  // Long transcripts → map/reduce: summarize each chunk first, then run the
  // rich prompt on the concatenated partials (now small enough to fit).
  if (text.length > SINGLE_SHOT_MAX_CHARS) {
    const chunks = splitTranscript(text, CHUNK_CHARS);
    console.log(
      `[Meet Assistant] Transcript dài ${text.length} ký tự → chia ${chunks.length} chunks`,
    );
    const partials: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[Meet Assistant] Tóm tắt chunk ${i + 1}/${chunks.length}…`);
      const p = await summarizeChunk(chunks[i], i + 1, chunks.length, settings);
      partials.push(p);
    }
    console.log('[Meet Assistant] Hợp nhất các phần thành output cuối…');
    const merged =
      `[LƯU Ý: Transcript gốc dài đã được tóm tắt sơ bộ thành ${chunks.length} phần dưới đây. Hãy tổng hợp toàn bộ thành output JSON cuối cùng theo format yêu cầu.]\n\n` +
      partials
        .map((p, i) => `=== Phần ${i + 1}/${chunks.length} ===\n${p}`)
        .join('\n\n');
    return await runFinalSummarize(meeting, merged, settings);
  }
  return await runFinalSummarize(meeting, text, settings);
}

async function runFinalSummarize(
  meeting: MeetingRecord,
  text: string,
  settings: UserSettings,
): Promise<SummaryResult> {

  // Choose prompt: user's custom takes precedence, else fall back to the
  // shared DEFAULT_SYSTEM_PROMPT (which itself contains {{TRANSCRIPT_HERE}}).
  const promptTemplate = settings.summary.customSystemPrompt?.trim()
    ? settings.summary.customSystemPrompt
    : DEFAULT_SYSTEM_PROMPT;
  const hasPlaceholder = TRANSCRIPT_PLACEHOLDER_RE.test(promptTemplate);
  TRANSCRIPT_PLACEHOLDER_RE.lastIndex = 0;

  let messages: { role: 'system' | 'user'; content: string }[];
  if (hasPlaceholder) {
    messages = [
      { role: 'system', content: fillPlaceholders(promptTemplate, meeting, text, settings) },
      { role: 'user', content: 'Generate the JSON response now.' },
    ];
  } else {
    // No placeholder: send template as system, transcript as user.
    const userMsg = [
      `Meeting title: ${meeting.title}`,
      `Date: ${new Date(meeting.createdAt).toISOString()}`,
      '',
      'Transcript:',
      text,
    ].join('\n');
    messages = [
      { role: 'system', content: fillPlaceholders(promptTemplate, meeting, '', settings) },
      { role: 'user', content: userMsg },
    ];
  }

  const content = await callChatAPI(messages, settings);
  console.log('[Meet Assistant] AI content:', content);
  if (!content) throw new Error('AI trả về rỗng');
  const parsed = normalizeResult(extractJson(content));
  console.log('[Meet Assistant] Parsed result:', parsed);
  return parsed;
}

// Accepts either a single JSON chat completion or an SSE stream
// (`data: {...}\n` lines per chunk) and returns the concatenated content.
function parseChatCompletion(raw: string): string {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as {
        choices?: { message?: { content?: string } }[];
      };
      return obj.choices?.[0]?.message?.content ?? '';
    } catch {
      // fall through to SSE parsing
    }
  }
  let out = '';
  for (const line of raw.split('\n')) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as {
        choices?: {
          delta?: { content?: string };
          message?: { content?: string };
        }[];
      };
      const delta = obj.choices?.[0]?.delta?.content;
      const message = obj.choices?.[0]?.message?.content;
      if (delta) out += delta;
      else if (message) out += message;
    } catch {
      // ignore malformed chunk
    }
  }
  return out;
}
