import { useEffect, useState } from 'preact/hooks';
import { getSettings, setSettings } from '@/shared/storage';
import { buildAIHeaders } from '@/shared/aiHeaders';
import {
  DEFAULT_DRAFT_EMAIL_LABELS,
  DEFAULT_MASKING,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TRANSCRIBE_PROMPT_VI,
  DEFAULT_TRANSCRIPTION_CONFIG,
  PROVIDER_PRESETS,
  TRANSCRIPTION_PRESETS,
} from '@/shared/constants';
import type {
  CaptionMode,
  DraftEmailLabels,
  MaskingPreferences,
  RetentionDays,
  TranscriptionConfig,
  UserSettings,
} from '@/shared/types';

type SectionId = 'ai' | 'caption' | 'summary' | 'masking' | 'calendar' | 'storage';

const PROVIDER_ICONS: Record<string, string> = {
  OpenAI: '🟢',
  Claude: '🟣',
  Groq: '⚡',
  Ollama: '🏠',
  OpenRouter: '🌐',
};

export function Options() {
  const [s, setS] = useState<UserSettings | null>(null);
  const [section, setSection] = useState<SectionId>('ai');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setS);
  }, []);

  if (!s) return <div style={{ padding: 32 }}>Loading…</div>;

  const save = async (patch: Partial<UserSettings>) => {
    const next = await setSettings(patch);
    setS(next);
    setSavedAt(Date.now());
  };

  const testApi = async () => {
    setTestStatus('Đang kiểm tra…');
    try {
      const res = await fetch(`${s.ai.endpoint.replace(/\/+$/, '')}/models`, {
        headers: buildAIHeaders(s.ai.endpoint, s.ai.apiKey),
      });
      setTestStatus(res.ok ? '✅ Kết nối thành công' : `❌ ${res.status} ${res.statusText}`);
    } catch (e) {
      setTestStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-logo">
          <img class="logo-icon" src={chrome.runtime.getURL('icons/icon-128.png')} alt="" />
          <div>
            <div class="logo-text">Meet Assistant</div>
            <div class="logo-sub">Settings</div>
          </div>
        </div>

        <NavGroup label="Cấu hình">
          <NavItem id="ai" current={section} onSelect={setSection} icon="🤖">
            AI Provider
          </NavItem>
          <NavItem id="caption" current={section} onSelect={setSection} icon="💬">
            Caption Mode
          </NavItem>
          <NavItem id="summary" current={section} onSelect={setSection} icon="📝">
            Summary
          </NavItem>
          <NavItem id="masking" current={section} onSelect={setSection} icon="🛡️">
            Masking PII
          </NavItem>
        </NavGroup>

        <NavGroup label="Tích hợp">
          <NavItem id="calendar" current={section} onSelect={setSection} icon="📅">
            Google Calendar
          </NavItem>
        </NavGroup>

        <NavGroup label="Dữ liệu">
          <NavItem id="storage" current={section} onSelect={setSection} icon="💾">
            Lưu trữ & Bảo mật
          </NavItem>
        </NavGroup>

        <div class="sidebar-footer">
          <span>Meet Assistant v0.1</span>
        </div>
      </aside>

      <main class="main">
        {section === 'ai' && (
          <AISection s={s} save={save} testApi={testApi} testStatus={testStatus} />
        )}
        {section === 'caption' && <CaptionSection s={s} save={save} />}
        {section === 'summary' && <SummarySection s={s} save={save} />}
        {section === 'masking' && <MaskingSection s={s} save={save} />}
        {section === 'calendar' && <CalendarSection />}
        {section === 'storage' && <StorageSection s={s} save={save} />}
        <div class="section-spacer" />
      </main>

      <div class="save-bar">
        <span class="save-hint">
          {savedAt ? `Đã lưu lúc ${new Date(savedAt).toLocaleTimeString()}` : 'Tự động lưu khi thay đổi'}
        </span>
        <button class="btn-save" onClick={() => setSavedAt(Date.now())}>
          💾 Đã lưu
        </button>
      </div>
    </div>
  );
}

function NavGroup({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div class="nav-section">
      <div class="nav-label">{label}</div>
      {children}
    </div>
  );
}

function NavItem({
  id,
  current,
  onSelect,
  icon,
  children,
}: {
  id: SectionId;
  current: SectionId;
  onSelect: (id: SectionId) => void;
  icon: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div class={`nav-item ${current === id ? 'active' : ''}`} onClick={() => onSelect(id)}>
      <span class="nav-icon">{icon}</span> {children}
    </div>
  );
}

// ---------- Sections ----------

export function AISection({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
  testApi?: () => Promise<void>;
  testStatus?: string | null;
}) {
  // Local draft — only commit to storage when user clicks "Lưu cấu hình".
  const [draft, setDraft] = useState(s.ai);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  useEffect(() => {
    setDraft(s.ai);
  }, [s.ai.endpoint, s.ai.apiKey, s.ai.model, s.ai.contextWindow]);

  // Test the draft (current form values), not the saved settings — lets the
  // user verify before committing.
  const testApi = async () => {
    setTestStatus('Đang kiểm tra…');
    try {
      const res = await fetch(`${draft.endpoint.replace(/\/+$/, '')}/models`, {
        headers: buildAIHeaders(draft.endpoint, draft.apiKey),
      });
      setTestStatus(res.ok ? '✅ Kết nối thành công' : `❌ ${res.status} ${res.statusText}`);
    } catch (e) {
      setTestStatus(`❌ ${(e as Error).message}`);
    }
  };

  const dirty =
    draft.endpoint !== s.ai.endpoint ||
    draft.apiKey !== s.ai.apiKey ||
    draft.model !== s.ai.model ||
    draft.contextWindow !== s.ai.contextWindow;

  const onSave = async () => {
    await save({ ai: draft });
    setSavedAt(Date.now());
  };
  const onReset = () => setDraft(s.ai);

  const isCustom = !PROVIDER_PRESETS.some((p) => p.endpoint === draft.endpoint);

  return (
    <>
      <div class="page-header">
        <div class="page-title">🤖 AI Provider</div>
        <div class="page-subtitle">
          Cấu hình API để tóm tắt cuộc họp. Key của bạn chỉ lưu local, không gửi đi đâu.
        </div>
      </div>

      <div class="card-row">
      <div class="card">
        <div class="card-header">
          <div class="card-title">⚡ Chọn nhanh provider</div>
        </div>
        <div class="card-body">
          <div class="provider-grid">
            {PROVIDER_PRESETS.map((p) => {
              const selected = draft.endpoint === p.endpoint;
              return (
                <div
                  class={`provider-card ${selected ? 'selected' : ''}`}
                  onClick={() =>
                    setDraft({ ...draft, endpoint: p.endpoint, model: p.defaultModel })
                  }
                >
                  <div class="provider-icon">{PROVIDER_ICONS[p.name] ?? '⚙️'}</div>
                  <div class="provider-name">{p.name}</div>
                  <div class="provider-desc">{p.defaultModel}</div>
                </div>
              );
            })}
            <div
              class={`provider-card ${isCustom ? 'selected' : ''}`}
              onClick={() => {
                if (!isCustom) setDraft({ ...draft, endpoint: '', model: '' });
              }}
            >
              <div class="provider-icon">⚙️</div>
              <div class="provider-name">Custom</div>
              <div class="provider-desc">
                {isCustom && draft.endpoint ? draft.endpoint : 'Tự nhập endpoint'}
              </div>
            </div>
          </div>
        </div>
      </div>

      </div>
      <div class="card-row">
      <div class="card">
        <div class="card-header">
          <div class="card-title">🔧 Cấu hình chi tiết</div>
        </div>
        <div class="card-body">
          <div class="form-row single">
            <div class="form-group">
              <label class="form-label">API Endpoint URL</label>
              <input
                class="form-input"
                type="url"
                value={draft.endpoint}
                onInput={(e) =>
                  setDraft({ ...draft, endpoint: (e.target as HTMLInputElement).value })
                }
              />
              <span class="form-hint">Endpoint tương thích OpenAI hoặc Anthropic</span>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">API Key</label>
              <input
                class="form-input password"
                type="password"
                value={draft.apiKey}
                placeholder="sk-..."
                onInput={(e) =>
                  setDraft({ ...draft, apiKey: (e.target as HTMLInputElement).value })
                }
              />
            </div>
            <div class="form-group">
              <label class="form-label">Model</label>
              <input
                class="form-input"
                type="text"
                value={draft.model}
                onInput={(e) =>
                  setDraft({ ...draft, model: (e.target as HTMLInputElement).value })
                }
              />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Context Window (tokens)</label>
              <input
                class="form-input"
                type="number"
                value={draft.contextWindow}
                onInput={(e) =>
                  setDraft({
                    ...draft,
                    contextWindow: Number((e.target as HTMLInputElement).value) || 128000,
                  })
                }
              />
            </div>
          </div>
          <div class="test-row">
            <button class="btn-test" onClick={testApi}>
              🔌 Test kết nối
            </button>
            {testStatus && (
              <span class="test-status" style={{ display: 'flex' }}>
                {testStatus}
              </span>
            )}
          </div>
          <div
            class="test-row"
            style={{
              marginTop: 12,
              borderTop: '1px solid var(--border)',
              paddingTop: 12,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <button
              class="btn-save"
              style={{
                padding: '8px 18px',
                background: dirty ? 'var(--primary)' : 'var(--bg)',
                color: dirty ? 'white' : 'var(--text-muted)',
                border: 'none',
                borderRadius: 6,
                fontWeight: 600,
                cursor: dirty ? 'pointer' : 'not-allowed',
                fontSize: 13,
              }}
              onClick={onSave}
              disabled={!dirty}
            >
              💾 Lưu cấu hình
            </button>
            <button
              class="btn-test"
              onClick={onReset}
              disabled={!dirty}
              style={{ opacity: dirty ? 1 : 0.5 }}
            >
              ↺ Huỷ thay đổi
            </button>
            {dirty && (
              <span style={{ color: '#92400e', fontSize: 12 }}>
                ⚠️ Có thay đổi chưa lưu
              </span>
            )}
            {!dirty && savedAt && (
              <span style={{ color: '#16a34a', fontSize: 12 }}>
                ✓ Đã lưu lúc {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

export function CaptionSection({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const options: { value: CaptionMode; title: string; desc: string; badge: string }[] = [
    {
      value: 'manual',
      title: 'Manual — Tự bật CC',
      desc: 'Extension chỉ đọc transcript khi bạn đã bật CC thủ công',
      badge: 'Privacy cao',
    },
    {
      value: 'ask',
      title: 'Ask — Hỏi trước khi bật CC',
      desc: 'Hiện banner hỏi ý kiến trước khi tự động bật CC',
      badge: 'Ít can thiệp',
    },
    {
      value: 'auto',
      title: 'Auto — Tự động bật CC',
      desc: 'Extension tự bật CC ngay khi phát hiện cuộc họp',
      badge: 'Mặc định',
    },
  ];

  return (
    <>
      <div class="page-header">
        <div class="page-title">💬 Caption Mode</div>
        <div class="page-subtitle">Chọn cách extension xử lý Closed Caption khi bạn vào Google Meet.</div>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="radio-group">
            {options.map((opt) => (
              <div
                class={`radio-option ${s.captionMode === opt.value ? 'selected' : ''}`}
                onClick={() => save({ captionMode: opt.value })}
              >
                <div class="radio-dot" />
                <div class="radio-text">
                  <div class="radio-title">{opt.title}</div>
                  <div class="radio-desc">{opt.desc}</div>
                </div>
                <span class="radio-badge">{opt.badge}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function SummarySection({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const items: [keyof UserSettings['summary'], string][] = [
    ['includeMeetingInfo', 'Thông tin cuộc họp (tên, thời gian, người tham gia, mục tiêu)'],
    ['includeSummary', 'Tóm tắt chính / Tổng kết ngắn gọn'],
    ['includeDiscussionTopics', 'Các vấn đề đã trao đổi'],
    ['includeKeyOpinions', 'Ý kiến quan trọng'],
    ['includeActionItems', 'Action Items (kèm người phụ trách, deadline, ưu tiên)'],
    ['includeDecisions', 'Quyết định đã thống nhất'],
    ['includePendingIssues', 'Khó khăn / rủi ro'],
    ['includeNextSteps', 'Các bước tiếp theo'],
    ['includeKeyQuotes', 'Key Quotes (trích dẫn quan trọng)'],
    ['includeDraftEmail', 'Draft email gửi quản lý'],
  ];
  return (
    <>
      <div class="page-header">
        <div class="page-title">📝 Summary Preferences</div>
        <div class="page-subtitle">Tùy chỉnh nội dung AI tóm tắt sau mỗi cuộc họp.</div>
      </div>
      <div class="card-row">
        <div class="card">
          <div class="card-header">
            <div class="card-title">📋 Nội dung tóm tắt</div>
          </div>
          <div class="card-body">
            <div class="checkbox-grid">
              {items.map(([key, label]) => {
                const checked = Boolean(s.summary[key]);
                return (
                  <div
                    class={`checkbox-item ${checked ? 'checked' : ''}`}
                    onClick={() => save({ summary: { ...s.summary, [key]: !checked } })}
                  >
                    <div class="checkbox-box">{checked ? '✓' : ''}</div>
                    <span class="checkbox-label">{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div class="card-row">
        <div class="card">
          <div class="card-header">
            <div class="card-title">🌐 Ngôn ngữ output</div>
          </div>
          <div class="card-body">
            <div class="form-row single">
              <div class="form-group">
                <select
                  class="form-select"
                  value={s.language}
                  onChange={(e) =>
                    save({ language: (e.target as HTMLSelectElement).value as UserSettings['language'] })
                  }
                >
                  <option value="vi">🇻🇳 Tiếng Việt</option>
                  <option value="en">🇺🇸 English</option>
                  <option value="auto">🌐 Auto detect</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="card-row">
        <DraftEmailLabelsCard s={s} save={save} />
      </div>
      <div class="card-row">
        <SystemPromptCard s={s} save={save} />
      </div>
    </>
  );
}

export function MaskingSection({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const m: MaskingPreferences = { ...DEFAULT_MASKING, ...(s.masking ?? {}) };
  const patch = (p: Partial<MaskingPreferences>) => save({ masking: { ...m, ...p } });

  const [dict, setDict] = useState(m.dictionary);
  useEffect(() => setDict(m.dictionary), [m.dictionary]);
  const dictDirty = dict !== m.dictionary;

  const toggles: [keyof MaskingPreferences, string, string][] = [
    ['maskSpeakers', 'Tên người nói & người tham gia', 'Lấy từ transcript — nguồn tên đáng tin cậy nhất'],
    ['useDictionary', 'Từ điển bên dưới', 'Đơn vị / dự án / khách hàng / thuật ngữ nhạy cảm bạn tự nhập'],
    ['maskEmails', 'Email', 'name@example.com'],
    ['maskPhones', 'Số điện thoại', '0901 234 567, +84…'],
    ['maskIds', 'Mã số / CCCD', 'Dãy số dài, mã nhân viên'],
    [
      'heuristicNames',
      'Tự đoán danh từ riêng tiếng Việt (thử nghiệm)',
      'Bắt thêm tên/đơn vị chưa có trong danh sách. Có thể ẩn nhầm hoặc bỏ sót.',
    ],
  ];

  return (
    <>
      <div class="page-header">
        <div class="page-title">🛡️ Masking PII</div>
        <div class="page-subtitle">
          Ẩn danh tên người, đơn vị, dự án và thông tin liên hệ <b>ngay trên máy trước khi gửi lên
          AI</b>. Bản tóm tắt cuối vẫn hiển thị thông tin thật — AI bên ngoài không bao giờ thấy dữ
          liệu gốc.
        </div>
      </div>

      <div class="card-row">
        <div class="card">
          <div class="card-body">
            <div
              class={`checkbox-item ${m.enabled ? 'checked' : ''}`}
              onClick={() => patch({ enabled: !m.enabled })}
            >
              <div class="checkbox-box">{m.enabled ? '✓' : ''}</div>
              <span class="checkbox-label">
                <b>Bật Masking khi tóm tắt</b> — ẩn danh trước khi gửi, khôi phục sau khi nhận kết
                quả
              </span>
            </div>
          </div>
        </div>
      </div>

      {m.enabled && (
        <>
          <div class="card-row">
            <div class="card">
              <div class="card-header">
                <div class="card-title">🔍 Loại thông tin cần ẩn</div>
              </div>
              <div class="card-body">
                <div class="checkbox-grid">
                  {toggles.map(([key, label, hint]) => {
                    const checked = Boolean(m[key]);
                    return (
                      <div
                        class={`checkbox-item ${checked ? 'checked' : ''}`}
                        onClick={() => patch({ [key]: !checked } as Partial<MaskingPreferences>)}
                        title={hint}
                      >
                        <div class="checkbox-box">{checked ? '✓' : ''}</div>
                        <span class="checkbox-label">{label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div class="card-row">
            <div class="card">
              <div class="card-header">
                <div class="card-title">📒 Từ điển nhạy cảm</div>
              </div>
              <div class="card-body">
                <label class="form-label">
                  Mỗi dòng một mục: tên đơn vị, dự án, khách hàng, sản phẩm, thuật ngữ nội bộ… Khớp
                  không phân biệt hoa thường.
                </label>
                <textarea
                  class="form-textarea"
                  rows={8}
                  placeholder={'FPT Software\nDự án Alpha\nKhách hàng ACME\nMã nguồn Helios'}
                  value={dict}
                  disabled={!m.useDictionary}
                  onInput={(e) => setDict((e.target as HTMLTextAreaElement).value)}
                />
                <div class="form-actions" style={{ marginTop: 8 }}>
                  <button class="btn-primary" disabled={!dictDirty} onClick={() => patch({ dictionary: dict })}>
                    Lưu từ điển
                  </button>
                  {dictDirty && <span class="muted">Chưa lưu</span>}
                </div>
              </div>
            </div>
          </div>

          <div class="card-row">
            <div class="card">
              <div class="card-body">
                <p class="muted" style={{ margin: 0 }}>
                  ℹ️ Khi bật, transcript gửi lên AI sẽ thay tên/đơn vị bằng placeholder dạng{' '}
                  <code>[[PER1]]</code>, <code>[[TRM1]]</code>… AI được yêu cầu giữ nguyên các
                  placeholder này; sau khi nhận kết quả, extension tự khôi phục lại giá trị thật.
                  Một số mô hình yếu có thể làm sai lệch placeholder — nếu thấy <code>[[…]]</code>
                  còn sót trong bản tóm tắt, hãy thử mô hình mạnh hơn.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function DraftEmailLabelsCard({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const merged: DraftEmailLabels = {
    ...DEFAULT_DRAFT_EMAIL_LABELS,
    ...(s.summary.draftEmailLabels ?? {}),
  };
  const [draft, setDraft] = useState<DraftEmailLabels>(merged);
  useEffect(() => {
    setDraft({ ...DEFAULT_DRAFT_EMAIL_LABELS, ...(s.summary.draftEmailLabels ?? {}) });
  }, [
    s.summary.draftEmailLabels?.ketQuaChinh,
    s.summary.draftEmailLabels?.noiDungThongNhat,
    s.summary.draftEmailLabels?.actionItems,
    s.summary.draftEmailLabels?.ruiRo,
    s.summary.draftEmailLabels?.buocTiepTheo,
  ]);

  const isCustom = (Object.keys(DEFAULT_DRAFT_EMAIL_LABELS) as (keyof DraftEmailLabels)[]).some(
    (k) => draft[k] !== DEFAULT_DRAFT_EMAIL_LABELS[k],
  );
  const dirty = (Object.keys(DEFAULT_DRAFT_EMAIL_LABELS) as (keyof DraftEmailLabels)[]).some(
    (k) => draft[k] !== merged[k],
  );

  const onSave = () => {
    // If everything matches default → store undefined (cleaner DB).
    const allDefault = (Object.keys(DEFAULT_DRAFT_EMAIL_LABELS) as (keyof DraftEmailLabels)[]).every(
      (k) => draft[k] === DEFAULT_DRAFT_EMAIL_LABELS[k],
    );
    save({
      summary: {
        ...s.summary,
        draftEmailLabels: allDefault ? undefined : draft,
      },
    });
  };
  const onLoadDefault = () => setDraft({ ...DEFAULT_DRAFT_EMAIL_LABELS });

  const fields: { key: keyof DraftEmailLabels; label: string }[] = [
    { key: 'ketQuaChinh', label: 'Mục 1' },
    { key: 'noiDungThongNhat', label: 'Mục 2' },
    { key: 'actionItems', label: 'Mục 3' },
    { key: 'ruiRo', label: 'Mục 4' },
    { key: 'buocTiepTheo', label: 'Mục 5' },
  ];

  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">📧 Tiêu đề các mục trong Draft Email</div>
        <span
          style={{
            fontSize: 11,
            padding: '3px 8px',
            borderRadius: 12,
            background: isCustom ? '#fef3c7' : '#dcfce7',
            color: isCustom ? '#92400e' : '#166534',
            fontWeight: 500,
          }}
        >
          {isCustom ? '✏️ Đang dùng custom' : '✓ Đang dùng mặc định'}
        </span>
      </div>
      <div class="card-body">
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
          Tuỳ biến tiêu đề các mục trong email. AI sẽ dùng các tên này khi sinh nội dung email
          gửi quản lý. Để trống 1 ô sẽ dùng giá trị mặc định.
        </p>
        {fields.map(({ key, label }) => (
          <div class="form-row single" key={key}>
            <div class="form-group">
              <label class="form-label">
                {label}{' '}
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                  (mặc định: {DEFAULT_DRAFT_EMAIL_LABELS[key]})
                </span>
              </label>
              <input
                class="form-input"
                type="text"
                value={draft[key]}
                placeholder={DEFAULT_DRAFT_EMAIL_LABELS[key]}
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  setDraft({ ...draft, [key]: v || DEFAULT_DRAFT_EMAIL_LABELS[key] });
                }}
              />
            </div>
          </div>
        ))}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 8,
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
            alignItems: 'center',
          }}
        >
          <button
            class="btn-save"
            style={{
              padding: '8px 18px',
              background: dirty ? 'var(--primary)' : 'var(--bg)',
              color: dirty ? 'white' : 'var(--text-muted)',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: dirty ? 'pointer' : 'not-allowed',
              fontSize: 13,
            }}
            onClick={onSave}
            disabled={!dirty}
          >
            💾 Lưu tiêu đề
          </button>
          <button class="btn-test" onClick={onLoadDefault}>
            ↺ Load mặc định
          </button>
          {dirty && (
            <span style={{ color: '#92400e', fontSize: 12 }}>⚠️ Có thay đổi chưa lưu</span>
          )}
        </div>
      </div>
    </div>
  );
}

function SystemPromptCard({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const isCustom =
    typeof s.summary.customSystemPrompt === 'string' &&
    s.summary.customSystemPrompt.trim().length > 0 &&
    s.summary.customSystemPrompt !== DEFAULT_SYSTEM_PROMPT;

  // Display value: show custom if user has saved one, otherwise show the
  // built-in default so the user can see and edit it.
  const value = s.summary.customSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const onChange = (next: string) => {
    // Save as custom only when it differs from the default; clearing it back
    // to the default removes the customization (column gets undefined).
    save({
      summary: {
        ...s.summary,
        customSystemPrompt: next === DEFAULT_SYSTEM_PROMPT ? undefined : next,
      },
    });
  };

  const reset = () => {
    if (!isCustom) return;
    if (!confirm('Khôi phục về prompt mặc định? Bản custom hiện tại sẽ bị xoá.')) return;
    save({ summary: { ...s.summary, customSystemPrompt: undefined } });
  };

  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">🛠️ System Prompt</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            style={{
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 12,
              background: isCustom ? '#fef3c7' : '#dcfce7',
              color: isCustom ? '#92400e' : '#166534',
              fontWeight: 500,
            }}
          >
            {isCustom ? '✏️ Đang dùng custom' : '✓ Đang dùng mặc định'}
          </span>
          <button
            class="btn-test"
            onClick={reset}
            disabled={!isCustom}
            style={{ opacity: isCustom ? 1 : 0.5 }}
          >
            ↺ Khôi phục mặc định
          </button>
        </div>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label">Prompt template gửi lên AI</label>
          <textarea
            class="form-textarea"
            rows={20}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            value={value}
            onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
          />
          <span class="form-hint">
            Hỗ trợ placeholder: <code>{'{{TRANSCRIPT_HERE}}'}</code>,{' '}
            <code>{'{{TITLE}}'}</code>, <code>{'{{DATE}}'}</code> — được thay bằng dữ liệu
            cuộc họp trước khi gửi lên AI. Nếu xoá hết về giống mặc định, hệ thống sẽ tự bỏ
            bản custom.
          </span>
        </div>
      </div>
    </div>
  );
}

export function CalendarSection() {
  return (
    <>
      <div class="page-header">
        <div class="page-title">📅 Google Calendar</div>
        <div class="page-subtitle">Sẽ khả dụng ở Phase 2.</div>
      </div>
      <div class="card">
        <div class="card-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Tích hợp Google Calendar OAuth sẽ được phát hành trong bản v0.2.
          </p>
        </div>
      </div>
    </>
  );
}

export function AIProviderSection({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const [tab, setTab] = useState<'summary' | 'audio'>('summary');
  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--border)',
          marginBottom: 20,
          marginTop: -8,
        }}
      >
        <div
          onClick={() => setTab('summary')}
          style={{
            padding: '10px 18px',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 600,
            color: tab === 'summary' ? 'var(--primary)' : 'var(--text-muted)',
            borderBottom: tab === 'summary' ? '2px solid var(--primary)' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          📝 Summary (text → JSON)
        </div>
        <div
          onClick={() => setTab('audio')}
          style={{
            padding: '10px 18px',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 600,
            color: tab === 'audio' ? 'var(--primary)' : 'var(--text-muted)',
            borderBottom: tab === 'audio' ? '2px solid var(--primary)' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          🎙️ Audio (transcribe)
        </div>
      </div>
      {tab === 'summary' ? (
        <AISection s={s} save={save} />
      ) : (
        <TranscriptionSection s={s} save={save} />
      )}
    </>
  );
}

export function TranscriptionSection({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const initial: TranscriptionConfig = s.transcription
    ? { ...DEFAULT_TRANSCRIPTION_CONFIG, ...s.transcription }
    : { ...DEFAULT_TRANSCRIPTION_CONFIG };
  const [draft, setDraft] = useState<TranscriptionConfig>(initial);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  useEffect(() => {
    setDraft(
      s.transcription
        ? { ...DEFAULT_TRANSCRIPTION_CONFIG, ...s.transcription }
        : { ...DEFAULT_TRANSCRIPTION_CONFIG },
    );
  }, [
    s.transcription?.endpoint,
    s.transcription?.apiKey,
    s.transcription?.model,
    s.transcription?.language,
    s.transcription?.chunkMinutes,
    s.transcription?.silenceAwareSplit,
    s.transcription?.diarization,
  ]);

  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify(s.transcription ?? DEFAULT_TRANSCRIPTION_CONFIG);
  const onSave = async () => {
    await save({ transcription: draft });
    setSavedAt(Date.now());
  };
  const onReset = () =>
    setDraft(
      s.transcription
        ? { ...DEFAULT_TRANSCRIPTION_CONFIG, ...s.transcription }
        : { ...DEFAULT_TRANSCRIPTION_CONFIG },
    );

  const testApi = async () => {
    setTestStatus('Đang kiểm tra…');
    try {
      const res = await fetch(`${draft.endpoint.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${draft.apiKey}` },
      });
      setTestStatus(res.ok ? '✅ Kết nối thành công' : `❌ ${res.status} ${res.statusText}`);
    } catch (e) {
      setTestStatus(`❌ ${(e as Error).message}`);
    }
  };

  const isCustom = !TRANSCRIPTION_PRESETS.some((p) => p.endpoint === draft.endpoint);

  return (
    <>
      <div class="card-row">
      <div class="card">
        <div class="card-header">
          <div class="card-title">⚡ Chọn nhanh provider</div>
        </div>
        <div class="card-body">
          <div class="provider-grid">
            {TRANSCRIPTION_PRESETS.map((p) => {
              const selected = draft.endpoint === p.endpoint;
              return (
                <div
                  class={`provider-card ${selected ? 'selected' : ''}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      endpoint: p.endpoint,
                      model: p.defaultModel,
                      diarization: p.diarization,
                    })
                  }
                >
                  <div class="provider-icon">🎙️</div>
                  <div class="provider-name">{p.name}</div>
                  <div class="provider-desc">{p.defaultModel}</div>
                </div>
              );
            })}
            <div
              class={`provider-card ${isCustom ? 'selected' : ''}`}
              onClick={() => {
                if (!isCustom) setDraft({ ...draft, endpoint: '', model: '' });
              }}
            >
              <div class="provider-icon">⚙️</div>
              <div class="provider-name">Custom</div>
              <div class="provider-desc">
                {isCustom && draft.endpoint ? draft.endpoint : 'Tự nhập endpoint'}
              </div>
            </div>
          </div>
        </div>
      </div>

      </div>
      <div class="card-row">
      <div class="card">
        <div class="card-header">
          <div class="card-title">🔧 Cấu hình chi tiết</div>
        </div>
        <div class="card-body">
          <div class="form-row single">
            <div class="form-group">
              <label class="form-label">Endpoint URL</label>
              <input
                class="form-input"
                type="url"
                value={draft.endpoint}
                onInput={(e) =>
                  setDraft({ ...draft, endpoint: (e.target as HTMLInputElement).value })
                }
              />
              <span class="form-hint">
                Endpoint sẽ POST tới <code>{'{endpoint}/audio/transcriptions'}</code> theo chuẩn
                OpenAI multipart.
              </span>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">API Key</label>
              <input
                class="form-input password"
                type="password"
                value={draft.apiKey}
                placeholder="sk-..."
                onInput={(e) =>
                  setDraft({ ...draft, apiKey: (e.target as HTMLInputElement).value })
                }
              />
            </div>
            <div class="form-group">
              <label class="form-label">Model</label>
              <input
                class="form-input"
                type="text"
                value={draft.model}
                placeholder="whisper-1"
                onInput={(e) =>
                  setDraft({ ...draft, model: (e.target as HTMLInputElement).value })
                }
              />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Ngôn ngữ</label>
              <select
                class="form-select"
                value={draft.language ?? 'auto'}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    language: (e.target as HTMLSelectElement).value as TranscriptionConfig['language'],
                  })
                }
              >
                <option value="auto">🌐 Auto detect</option>
                <option value="vi">🇻🇳 Tiếng Việt</option>
                <option value="en">🇺🇸 English</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Chunk size (phút)</label>
              <input
                class="form-input"
                type="number"
                min={1}
                max={25}
                value={draft.chunkMinutes}
                onInput={(e) =>
                  setDraft({
                    ...draft,
                    chunkMinutes: Math.max(1, Number((e.target as HTMLInputElement).value) || 10),
                  })
                }
              />
              <span class="form-hint">File dài hơn sẽ tự chia. Whisper limit 25MB ≈ 25 phút.</span>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={draft.silenceAwareSplit}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      silenceAwareSplit: (e.target as HTMLInputElement).checked,
                    })
                  }
                />
                <span>Cắt chunk tại khoảng lặng (tránh cụt câu)</span>
              </label>
            </div>
            <div class="form-group">
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={!!draft.diarization}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      diarization: (e.target as HTMLInputElement).checked,
                    })
                  }
                />
                <span>Phân biệt người nói (provider phải hỗ trợ)</span>
              </label>
            </div>
          </div>
          <div class="form-row single">
            <div class="form-group">
              <label class="form-label">
                Prompt định hướng (giúp Whisper transcribe đúng từ vựng, giảm hallucinate)
              </label>
              <textarea
                class="form-textarea"
                rows={4}
                value={draft.prompt ?? ''}
                placeholder={DEFAULT_TRANSCRIBE_PROMPT_VI}
                onInput={(e) =>
                  setDraft({ ...draft, prompt: (e.target as HTMLTextAreaElement).value })
                }
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button
                  class="btn-test"
                  type="button"
                  onClick={() =>
                    setDraft({ ...draft, prompt: DEFAULT_TRANSCRIBE_PROMPT_VI })
                  }
                >
                  📝 Dùng prompt mẫu (VI)
                </button>
                <button
                  class="btn-test"
                  type="button"
                  onClick={() => setDraft({ ...draft, prompt: '' })}
                >
                  ✕ Xoá
                </button>
              </div>
              <span class="form-hint">
                Whisper accept tối đa ~244 tokens prompt. Liệt kê tên riêng / thuật ngữ kỹ
                thuật giúp transcribe chính xác hơn. Bỏ trống nếu không cần.
              </span>
            </div>
          </div>
          <div class="test-row">
            <button class="btn-test" onClick={testApi}>🔌 Test kết nối</button>
            {testStatus && (
              <span class="test-status" style={{ display: 'flex' }}>
                {testStatus}
              </span>
            )}
          </div>
          <div
            class="test-row"
            style={{
              marginTop: 12,
              borderTop: '1px solid var(--border)',
              paddingTop: 12,
              gap: 8,
              alignItems: 'center',
            }}
          >
            <button
              class="btn-save"
              style={{
                padding: '8px 18px',
                background: dirty ? 'var(--primary)' : 'var(--bg)',
                color: dirty ? 'white' : 'var(--text-muted)',
                border: 'none',
                borderRadius: 6,
                fontWeight: 600,
                cursor: dirty ? 'pointer' : 'not-allowed',
                fontSize: 13,
              }}
              onClick={onSave}
              disabled={!dirty}
            >
              💾 Lưu cấu hình
            </button>
            <button
              class="btn-test"
              onClick={onReset}
              disabled={!dirty}
              style={{ opacity: dirty ? 1 : 0.5 }}
            >
              ↺ Huỷ thay đổi
            </button>
            {dirty && (
              <span style={{ color: '#92400e', fontSize: 12 }}>⚠️ Có thay đổi chưa lưu</span>
            )}
            {!dirty && savedAt && (
              <span style={{ color: '#16a34a', fontSize: 12 }}>
                ✓ Đã lưu lúc {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

export function StorageSection({
  s,
  save,
}: {
  s: UserSettings;
  save: (p: Partial<UserSettings>) => Promise<void>;
}) {
  const opts: { value: RetentionDays; title: string; desc?: string; badge?: string }[] = [
    { value: 7, title: '7 ngày' },
    { value: 30, title: '30 ngày', badge: 'Mặc định' },
    { value: 90, title: '90 ngày' },
    { value: 0, title: 'Không tự xóa', desc: 'Phù hợp nếu bạn muốn lưu transcript lâu dài' },
  ];

  const wipeAll = async () => {
    if (!confirm('Xóa toàn bộ dữ liệu? Không thể hoàn tác.')) return;
    await chrome.storage.local.clear();
    indexedDB.deleteDatabase('meet-assistant');
    location.reload();
  };

  return (
    <>
      <div class="page-header">
        <div class="page-title">💾 Lưu trữ & Bảo mật</div>
        <div class="page-subtitle">
          Toàn bộ data lưu local trên máy bạn. Không có server nào nhận dữ liệu.
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">🗓️ Data Retention</div>
        </div>
        <div class="card-body">
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
            Chỉ xóa <strong>transcript raw</strong>. Summary và action items được giữ lại vĩnh viễn trừ khi bạn xóa thủ công.
          </p>
          <div class="radio-group">
            {opts.map((opt) => (
              <div
                class={`radio-option ${s.retentionDays === opt.value ? 'selected' : ''}`}
                onClick={() => save({ retentionDays: opt.value })}
              >
                <div class="radio-dot" />
                <div class="radio-text">
                  <div class="radio-title">{opt.title}</div>
                  {opt.desc && <div class="radio-desc">{opt.desc}</div>}
                </div>
                {opt.badge && <span class="radio-badge">{opt.badge}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title" style={{ color: 'var(--danger)' }}>⚠️ Danger Zone</div>
        </div>
        <div class="card-body">
          <div class="danger-row">
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Xóa toàn bộ dữ liệu</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Xóa hết transcript, summary, lịch sử và cài đặt
              </div>
            </div>
            <button class="btn-danger" onClick={wipeAll}>
              Xóa tất cả
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
