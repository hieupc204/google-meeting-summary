// PII masking / pseudonymization.
//
// Goal: the external AI endpoint must never see real names, organizations,
// project names, or contact details. We replace those entities with stable
// placeholder tokens BEFORE the transcript leaves the device, ask the model to
// keep the tokens verbatim, then restore the real values in the returned
// summary. The final summary the user sees is identical to an unmasked run —
// only the bytes sent over the network are scrubbed.
//
// Detection is fully local (no AI involved in detection, by design):
//   1. Speaker labels + participant names from the transcript (most reliable).
//   2. A user-maintained dictionary of orgs / projects / clients / sensitive terms.
//   3. Regex for emails, phone numbers, and long id/number sequences.
//   4. An optional, conservative heuristic for Vietnamese proper nouns.
//
// Token format `[[PER1]]` is deliberately unusual so models pass it through
// paraphrasing untouched; unmasking is tolerant of minor whitespace/case drift.

import type {
  ActionItem,
  MaskingPreferences,
  TranscriptEntry,
  TranscriptLine,
  TranscriptRecord,
} from './types';

export interface MaskContext {
  enabled: boolean;
  prefs: MaskingPreferences;
  // original (lowercased) -> token, so the same entity always maps to the same token.
  byOriginal: Map<string, string>;
  // token -> original (display form), for restoring the summary.
  byToken: Map<string, string>;
  // Registered entities sorted longest-first, for greedy phrase replacement.
  ordered: { original: string; token: string }[];
  counters: Record<string, number>;
}

type Category = 'PER' | 'ORG' | 'TRM' | 'EML' | 'PHN' | 'ID';

function isLine(e: TranscriptEntry): e is TranscriptLine {
  return (e as TranscriptLine).hash !== undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Boundary that works with Unicode letters (plain \b breaks on diacritics).
function entityRegex(original: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\d])${escapeRegExp(original)}(?![\\p{L}\\d])`, 'giu');
}

function nextToken(ctx: MaskContext, cat: Category): string {
  ctx.counters[cat] = (ctx.counters[cat] ?? 0) + 1;
  return `[[${cat}${ctx.counters[cat]}]]`;
}

// Register an entity and return its (possibly pre-existing) token. Returns null
// for values too trivial to be worth masking.
function register(ctx: MaskContext, original: string, cat: Category): string | null {
  const trimmed = original.trim();
  if (trimmed.length < 2) return null;
  const key = trimmed.toLowerCase();
  const existing = ctx.byOriginal.get(key);
  if (existing) return existing;
  const token = nextToken(ctx, cat);
  ctx.byOriginal.set(key, token);
  ctx.byToken.set(token, trimmed);
  ctx.ordered.push({ original: trimmed, token });
  // Keep longest-first so "Nguyễn Văn A" is replaced before "Nguyễn".
  ctx.ordered.sort((a, b) => b.original.length - a.original.length);
  return token;
}

function parseDictionary(raw: string): string[] {
  return raw
    .split(/[\n,;|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

const DISABLED: MaskContext = {
  enabled: false,
  prefs: {
    enabled: false,
    maskSpeakers: false,
    useDictionary: false,
    dictionary: '',
    maskEmails: false,
    maskPhones: false,
    maskIds: false,
    heuristicNames: false,
  },
  byOriginal: new Map(),
  byToken: new Map(),
  ordered: [],
  counters: {},
};

// Build a context pre-seeded with the high-confidence entities (speakers +
// dictionary). Regex / heuristic entities are discovered lazily during maskText
// so their tokens stay deterministic relative to first appearance.
export function createMaskContext(
  transcript: TranscriptRecord | null | undefined,
  prefs: MaskingPreferences | undefined,
  extraNames: string[] = [],
): MaskContext {
  if (!prefs?.enabled) return DISABLED;
  const ctx: MaskContext = {
    enabled: true,
    prefs,
    byOriginal: new Map(),
    byToken: new Map(),
    ordered: [],
    counters: {},
  };

  if (prefs.maskSpeakers) {
    const names = new Set<string>();
    for (const n of extraNames) if (n?.trim()) names.add(n.trim());
    for (const e of transcript?.lines ?? []) {
      if (isLine(e) && e.speaker?.trim()) names.add(e.speaker.trim());
    }
    // Register longest names first so multi-word names win.
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
      register(ctx, n, 'PER');
    }
  }

  if (prefs.useDictionary) {
    for (const term of parseDictionary(prefs.dictionary)) register(ctx, term, 'TRM');
  }

  return ctx;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Vietnamese / international phone numbers: optional +, then 8–15 digits with
// common separators. Anchored away from longer digit runs handled by id rule.
const PHONE_RE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}(?!\d)/g;
// Long bare identifiers (CCCD 9–12 digits, employee codes mixing letters+digits).
const ID_RE = /(?<![\w])(?:\d[\d\s.-]{7,}\d|[A-Z]{2,}\d{3,}|\d{3,}[A-Z]{2,})(?![\w])/g;

// Conservative Vietnamese proper-noun heuristic: 2+ consecutive capitalized
// words (optionally led by a personal title). Single capitalized words are
// skipped to avoid masking every sentence-initial word.
const TITLE = '(?:anh|chị|chi|ông|ong|bà|ba|em|cô|co|chú|chu|bác|bac|ngài|ngai|mr|mrs|ms|dr)';
const HEURISTIC_RE = new RegExp(
  `(?:${TITLE}\\s+)?(\\p{Lu}[\\p{Ll}]+(?:\\s+\\p{Lu}[\\p{Ll}]+){1,3})`,
  'gu',
);

function maskRegexCategory(text: string, re: RegExp, cat: Category, ctx: MaskContext): string {
  return text.replace(re, (match) => {
    const token = register(ctx, match.trim(), cat);
    return token ?? match;
  });
}

// Replace every registered entity, then run the enabled regex/heuristic passes.
export function maskText(text: string, ctx: MaskContext): string {
  if (!ctx.enabled || !text) return text;
  let out = text;

  // Registered phrases first (longest-first via ctx.ordered).
  for (const { original, token } of ctx.ordered) {
    out = out.replace(entityRegex(original), token);
  }

  if (ctx.prefs.maskEmails) out = maskRegexCategory(out, EMAIL_RE, 'EML', ctx);
  if (ctx.prefs.maskIds) out = maskRegexCategory(out, ID_RE, 'ID', ctx);
  if (ctx.prefs.maskPhones) out = maskRegexCategory(out, PHONE_RE, 'PHN', ctx);

  if (ctx.prefs.heuristicNames) {
    out = out.replace(HEURISTIC_RE, (match, name: string) => {
      // Don't touch text that already contains a token (e.g. "[[PER1]]").
      if (match.includes('[[')) return match;
      const token = register(ctx, name, 'PER');
      if (!token) return match;
      // Preserve any leading title prefix that wasn't part of the captured name.
      return match.replace(name, token);
    });
  }

  return out;
}

// Instruction appended to the system prompt so the model keeps tokens intact.
export function maskInstruction(ctx: MaskContext): string {
  if (!ctx.enabled) return '';
  return [
    '',
    'QUAN TRỌNG — DỮ LIỆU ĐÃ ẨN DANH:',
    'Một số tên người, đơn vị, dự án và thông tin liên hệ trong transcript đã được thay bằng placeholder dạng [[PER1]], [[ORG1]], [[TRM1]], [[EML1]], [[PHN1]], [[ID1]] (chữ + số trong hai dấu ngoặc vuông kép).',
    '- GIỮ NGUYÊN các placeholder này y hệt trong toàn bộ output (kể cả trong tên người phụ trách, thành phần tham gia, draft email, từ khoá).',
    '- TUYỆT ĐỐI KHÔNG dịch, đổi tên, đoán tên thật, gộp hay tách các placeholder.',
    '- Coi mỗi placeholder như một danh từ riêng cố định khi viết câu.',
  ].join('\n');
}

// Tolerant token matcher. Models routinely mangle `[[PER1]]` into `per1`,
// `[PER1]`, `PER 1`, `PER-1`, etc. — so we match the category+number core with
// optional brackets / separators / case, anchored so it can't match a longer
// number (PER1 must not swallow PER10) or a surrounding word.
function tokenRegex(token: string): RegExp {
  const inner = token.slice(2, -2); // e.g. "PER1"
  const m = inner.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return new RegExp(escapeRegExp(token), 'gi');
  const [, cat, num] = m;
  // Bracketed form allows internal spaces ("[[ PER 1 ]]"); bare form allows a
  // single separator (space/dash/underscore/hash) but never consumes trailing
  // whitespace ("per1 báo cáo" / "PER 1 báo cáo" → keep the following space).
  const bracketed = `\\[{1,2}\\s*${cat}\\s*[-_ #]?\\s*0*${num}\\s*\\]{1,2}`;
  const bare = `${cat}[ \\-_#]{0,2}0*${num}`;
  return new RegExp(`(?<![A-Za-z0-9])(?:${bracketed}|${bare})(?![0-9A-Za-z])`, 'gi');
}

// After unmasking, report any residual token-shaped strings the model produced
// in a form we couldn't recognize — invaluable for diagnosing leaks.
const RESIDUAL_RE = /\[{0,2}\s*(?:PER|ORG|TRM|EML|PHN|ID)[\s\-_#]?\d+\s*\]{0,2}/gi;

export function findResidualTokens(text: string): string[] {
  return [...new Set(text.match(RESIDUAL_RE) ?? [])];
}

export function unmask(text: string, ctx: MaskContext): string {
  if (!ctx.enabled || !text) return text;
  let out = text;
  for (const [token, original] of ctx.byToken) {
    out = out.replace(tokenRegex(token), original);
  }
  return out;
}

function unmaskActionItem(a: ActionItem, ctx: MaskContext): ActionItem {
  return {
    text: unmask(a.text, ctx),
    assignee: a.assignee ? unmask(a.assignee, ctx) : a.assignee,
    due: a.due ? unmask(a.due, ctx) : a.due,
    priority: a.priority,
    status: a.status,
  };
}

// Summary-shaped subset this module restores. Structurally compatible with
// ai.ts's SummaryResult (kept separate to avoid a circular import).
export interface MaskableSummary {
  summary: string;
  actionItems: ActionItem[];
  decisions: string[];
  pendingIssues: string[];
  draftEmail?: { subject: string; body: string };
  keywords?: string[];
  meetingDate?: string;
  meetingTime?: string;
  meetingFormat?: string;
  participants?: string[];
  chair?: string;
  objective?: string;
}

const u = (s: string | undefined, ctx: MaskContext) =>
  s === undefined ? undefined : unmask(s, ctx);

// Deeply restore every string field of a summary-shaped result.
export function unmaskResult<T extends MaskableSummary>(result: T, ctx: MaskContext): T {
  if (!ctx.enabled) return result;
  return {
    ...result,
    summary: unmask(result.summary, ctx),
    actionItems: result.actionItems.map((a) => unmaskActionItem(a, ctx)),
    decisions: result.decisions.map((d) => unmask(d, ctx)),
    pendingIssues: result.pendingIssues.map((p) => unmask(p, ctx)),
    keywords: result.keywords?.map((k) => unmask(k, ctx)),
    participants: result.participants?.map((p) => unmask(p, ctx)),
    chair: u(result.chair, ctx),
    objective: u(result.objective, ctx),
    meetingDate: u(result.meetingDate, ctx),
    meetingTime: u(result.meetingTime, ctx),
    meetingFormat: u(result.meetingFormat, ctx),
    draftEmail: result.draftEmail
      ? {
          subject: unmask(result.draftEmail.subject, ctx),
          body: unmask(result.draftEmail.body, ctx),
        }
      : result.draftEmail,
  };
}
