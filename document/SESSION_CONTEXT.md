# Session Context — Google Meet AI Assistant Extension
> Load file này vào đầu session mới để tiếp tục công việc

---

## Tổng quan dự án

Xây dựng **Chrome Extension** hỗ trợ Google Meet:
- Capture transcript từ Closed Caption (CC) DOM — không cần backend
- Người dùng tự cấu hình AI API (endpoint + key + model)
- AI tóm tắt cuộc họp sau khi kết thúc
- Tự động push summary lên Google Calendar event tương ứng
- Lưu lịch sử local (IndexedDB), không có server

**Triết lý:** Privacy-first, 100% client-side, user tự mang API key.

---

## Các quyết định kiến trúc đã thống nhất

### Storage
- `IndexedDB` — lưu transcript raw + meeting metadata đầy đủ
- `chrome.storage.local` — chỉ lưu settings, recentMeetingIds, userPreferences
- Schema IndexedDB:
  - Store `transcripts`: id, lines[], createdAt
  - Store `meetings`: id, title, summary, actionItems[], decisions[], summaryStatus, calendarEventId, duration, createdAt

### AI API
- User tự nhập: API endpoint URL + API key + model name
- Preset providers: OpenAI, Anthropic (Claude), Groq, Ollama (local), OpenRouter, Custom
- Token estimation trước khi gọi: ~ký tự/4 (EN), ~ký tự/2 (VI)
- Chunking nếu vượt 80% context window: maxChunkTokens=12k–20k, maxChunkDuration=20 phút
- Cắt chunk tại speaker turn boundary, overlap 30s hoặc 2–3 turns

### Caption Mode (3 chế độ)
- Manual: user tự bật CC
- Ask (mặc định): extension hỏi trước khi bật
- Auto: tự bật CC khi vào meeting

### Error Handling
- summaryStatus: pending | processing | completed | failed
- Retry: 3 lần với exponential backoff (3s → 8s → manual)
- Luôn lưu transcript dù AI lỗi
- User có thể retry từ History

### Data Retention
- Auto xóa transcript raw sau 30 ngày (mặc định)
- Giữ summary + action items vĩnh viễn
- Options: 7 / 30 / 90 ngày / Never

### Meeting Title Detection
1. Google Calendar event title (nếu đã OAuth)
2. Tab title của Google Meet (cắt " - Google Meet")
3. Fallback: "Meeting YYYY-MM-DD HH:mm"

### Pause Capture
- Nút Pause trong Popup khi đang capturing
- Transcript có marker: `--- [Capture paused: 10:15 → 10:21] ---`

### Share Summary (sau khi summarize)
- Copy Markdown (Notion, GitHub)
- Copy Plain Text (Gmail, Slack)
- Export .md file

### Manifest Permissions
```json
"permissions": ["storage", "identity", "tabs", "activeTab", "offscreen"],
"host_permissions": ["https://meet.google.com/*", "https://www.googleapis.com/*"]
```

### IndexedDB Migration
- Dùng `DB_VERSION` + `onupgradeneeded`
- Không xóa data cũ khi migrate, chỉ thêm field/index mới

### Speech-to-Text (Phase 2, optional)
- Recommendation: Groq Whisper Large v3 (miễn phí, nhanh, tiếng Việt tốt)
- User điền Groq API key vào Options page, cùng cơ chế với AI key
- Fallback: Self-host Faster-Whisper / WhisperX

---

## Cấu trúc thư mục dự án

```
/Users/hieupc/Desktop/google-meeting-sumary/
│
├── document/
│   ├── google-meet-ai-assistant-proposal-v2.1.md   ← Proposal đầy đủ (23 sections)
│   └── SESSION_CONTEXT.md                          ← File này
│
├── html/                                            ← UI mockup đã làm xong
│   ├── popup.html      ← Extension popup (4 states: capturing/paused/waiting/idle)
│   ├── options.html    ← Settings page (sidebar + 5 sections)
│   └── history.html    ← Meeting history (search, expand, tabs, export)
│
└── src/                ← Chưa có gì, bước tiếp theo
```

---

## Roadmap

| Phase | Nội dung | Status |
|-------|---------|--------|
| Proposal | Technical design đầy đủ | ✅ Xong |
| HTML Mockup | UI/UX 3 trang | ✅ Xong |
| Phase 1 MVP | Extension scaffold + CC capture + AI summary + History | ⬜ Chưa bắt đầu |
| Phase 2 | Google Calendar OAuth + push summary | ⬜ Chưa |
| Phase 3 | UX polish, search, notifications | ⬜ Chưa |
| Phase 4 | Audio recording + STT (optional) | ⬜ Chưa |

---

## Bước tiếp theo (Phase 1 MVP)

Scaffold project trong `/src` với:
- Vite + TypeScript + CRXJS
- `manifest.json` (MV3)
- `background.ts` — service worker, AI API calls
- `content.ts` — detect Google Meet, CC capture, MutationObserver
- `popup/` — React hoặc vanilla TS, dựa trên popup.html mockup
- `options/` — settings page, dựa trên options.html mockup
- `lib/db.ts` — IndexedDB wrapper (transcripts + meetings stores)
- `lib/ai.ts` — gọi AI API với chunking logic
- `lib/chunker.ts` — speaker-aware transcript chunking

---

## Tech stack đã chọn

| Layer | Công nghệ |
|-------|-----------|
| Extension | Manifest V3, TypeScript |
| Build | Vite + CRXJS plugin |
| Storage | IndexedDB + chrome.storage.local |
| Auth | Chrome Identity API (OAuth2 PKCE) |
| AI | User-configurable (OpenAI-compatible hoặc Anthropic) |
| STT (optional) | Groq Whisper hoặc self-host Faster-Whisper |
