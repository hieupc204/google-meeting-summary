# Google Meet AI Meeting Assistant — Chrome Extension
## Technical Proposal v2.1

---

# 1. Tổng quan dự án

## Mục tiêu

Xây dựng Chrome Extension hoạt động hoàn toàn client-side:

- Capture transcript từ Google Meet CC
- Người dùng tự cấu hình AI API
- AI summary cuộc họp
- Action items
- Google Calendar sync
- Export Markdown
- Local meeting history
- Không cần backend riêng
- Toàn bộ data lưu local

---

# 2. Tư tưởng sản phẩm

## Privacy-first

Khác với các sản phẩm như Otter.ai hoặc Fireflies:

- Không có backend riêng
- Không upload transcript lên server trung gian
- User tự dùng API key của họ
- Transcript chỉ nằm trong browser
- Người dùng kiểm soát toàn bộ dữ liệu

---

# 3. Kiến trúc hệ thống

```text
Chrome Extension (100% local)
│
├── Options Page
│   ├── AI Provider Config
│   ├── API Key
│   ├── Google OAuth
│   └── Caption Mode
│
├── Content Script
│   ├── Detect Google Meet
│   ├── Caption Capture
│   └── Transcript Observer
│
├── Popup UI
│   ├── Meeting Status
│   ├── Transcript Realtime
│   └── End & Summarize
│
└── Background Worker
    ├── AI API Calls
    ├── Google Calendar API
    └── Local Storage Management
```

---

# 4. Caption Capture Mode

## Mục tiêu

Cho phép người dùng tự quyết định cách bật Closed Caption (CC).

## Các chế độ

| Mode | Mô tả | Phù hợp |
|------|------|---------|
| Manual | User tự bật CC trong Google Meet | Privacy cao |
| Ask before enabling | Extension hỏi trước khi bật CC | Mặc định |
| Auto enable captions | Extension tự bật CC khi vào meeting | Power user |

## Default mode

```text
Ask before enabling
```

## UX Flow

### Manual Mode

```text
User tự bật CC
→ Extension detect transcript
→ Start capturing
```

### Ask Before Enabling

```text
User vào Google Meet
→ Extension detect CC đang OFF
→ Hiện banner nhỏ:
   "Để ghi transcript cần bật phụ đề"
   [Bật CC] [Không nhắc lại]
→ Nếu user đồng ý
→ Extension bật CC
```

### Auto Enable Mode

```text
User vào Google Meet
→ Extension tự bật CC
→ Start capturing transcript
```

---

# 5. Meeting Status UI

Popup hiển thị trạng thái rõ ràng:

```text
🟢 Capturing captions
🟡 Waiting for captions
🔴 Captions disabled
⚪ Meeting not detected
```

Nếu không thấy transcript sau 30 giây:

```text
Chưa phát hiện transcript.
Bạn có muốn bật CC để bắt đầu ghi transcript không?
```

---

# 6. Pause Capture

## Mục tiêu

Cho phép user tạm dừng ghi transcript mà không cần kết thúc session — phục vụ các tình huống thảo luận nhạy cảm (lương, nhân sự, thông tin nội bộ...).

## UX

Nút Pause hiển thị trong Popup khi đang capturing:

```
🟢 Capturing  [⏸ Pause]

  ↓ sau khi pause

🟡 Paused (đã dừng 2:14)  [▶ Resume]
```

## Transcript khi pause

Đoạn bị pause sẽ được đánh dấu rõ trong transcript:

```
[10:14] Nguyễn Văn A:
Phần backend đã xong, tiếp theo là...

--- [Capture paused: 10:15 → 10:21] ---

[10:21] Nguyễn Văn A:
OK quay lại phần deploy thôi.
```

AI summary sẽ biết có khoảng bị bỏ qua, không tự điền nội dung vào.

---

# 7. Options Page

## AI Provider Config

Người dùng tự nhập:

- API endpoint
- API key
- Model name

Ví dụ:

| Provider | Endpoint |
|----------|----------|
| OpenAI | https://api.openai.com/v1 |
| Claude | https://api.anthropic.com/v1 |
| Groq | https://api.groq.com/openai/v1 |
| Ollama | http://localhost:11434/v1 |
| OpenRouter | https://openrouter.ai/api/v1 |

---

## Summary Preferences

Cho phép bật/tắt:

- Tóm tắt chính
- Action items
- Decisions
- Pending issues
- Key quotes

Custom system prompt:

```text
Bạn là trợ lý tóm tắt cuộc họp chuyên nghiệp...
```

---

## Data Retention Setting

Tự động xóa transcript cũ để tránh IndexedDB phình to:

```
Auto delete transcript after:
○ Never
● 30 days  (mặc định)
○ 7 days
○ 90 days
```

Chỉ xóa **transcript raw** (dữ liệu lớn), giữ lại **summary + action items** vĩnh viễn trừ khi user xóa thủ công.

> Default `30 days` — cân bằng giữa privacy và tiện dụng. User muốn giữ lâu hơn tự chỉnh sang `Never`.

---

# 8. Transcript Capture

## Detect Google Meet

```javascript
const isMeetingActive = () => {
  return window.location.pathname.match(/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/);
};
```

---

## MutationObserver

```javascript
const observer = new MutationObserver((mutations) => {
  // capture transcript realtime
});
```

---

# 9. Meeting Title Detection

## Chiến lược lấy tên cuộc họp

Tên meeting ảnh hưởng đến cả History display lẫn Calendar matching, cần fallback rõ ràng:

```
Ưu tiên 1: Google Calendar event title
           (nếu user đã OAuth, tìm event có start time gần nhất)
           → "Sprint Planning W19"

Ưu tiên 2: Tab title của Google Meet tab
           → document.title thường có dạng "Tên meeting - Google Meet"
           → Cắt bỏ " - Google Meet" ở cuối

Ưu tiên 3: "Meeting YYYY-MM-DD HH:mm" (fallback)
           → Luôn có, không bao giờ null
```

User có thể đổi tên thủ công trong Popup trước khi kết thúc session.

---

# 10. Transcript Optimization

## Vấn đề

Google Meet caption thường:

- update liên tục
- duplicate text
- split sentence
- replace text theo từng chữ

## Giải pháp

### Debounce

Delay 300–500ms trước khi commit transcript.

### Merge transcript

Gộp transcript cùng speaker trong khoảng 3–5 giây.

### Deduplicate

Hash:

```text
speaker + normalizedText
```

để tránh duplicate.

---

# 11. AI Summary Flow

## Flow tổng quát

```text
Transcript raw
→ Token estimation
→ Nếu ngắn: gọi AI 1 lần
→ Nếu dài: chunk → summarize từng phần → merge
→ Final Summary + Action Items + Decisions
```

## Token Estimation

Trước khi gọi AI, ước tính số token để tránh lỗi `context_length_exceeded`:

```text
Số token ≈ số ký tự / 4  (tiếng Anh)
Số token ≈ số ký tự / 2  (tiếng Việt, CJK)

Nếu token_count < 80% context_window → gọi thẳng
Nếu token_count ≥ 80% context_window → chunking
```

Ví dụ với gpt-4o (128K context):

```text
Meeting 1 tiếng ≈ 15.000–30.000 tokens → gọi thẳng
Meeting 3 tiếng ≈ 60.000–90.000 tokens → cần chunk
```

## Chunking Strategy

### Giới hạn an toàn cho mỗi chunk

```text
maxChunkTokens   = 12.000 – 20.000 tokens
maxChunkDuration = 20 phút
overlap          = 30 giây  hoặc  2–3 speaker turns (lấy cái nào đến trước)
```

Dùng cả hai điều kiện vì:
- Meeting ít người nói → 20 phút vẫn là 1 speaker nói liên tục, token có thể vượt limit
- Meeting nhiều người nói → có thể cắt sớm hơn 20 phút khi đã đủ token

### Nguyên tắc cắt chunk

Không cắt theo số ký tự cứng — dễ cắt giữa câu hoặc giữa lượt nói.

Cắt tại **speaker turn boundary** gần nhất với mốc mục tiêu (thời gian hoặc token):

```text
Mục tiêu: chunk ~15.000 tokens hoặc ~20 phút
→ Duyệt từng speaker turn, tính token tích lũy
→ Khi token ≥ maxChunkTokens HOẶC thời gian ≥ maxChunkDuration
→ Cắt tại cuối speaker turn hiện tại (không cắt giữa lượt nói)
→ Giữ lại 2–3 lượt nói cuối làm context overlap cho chunk tiếp theo
```

### Context Overlap

```text
Chunk 1: [00:00 → 18:30]
Chunk 2: [18:00 → 36:00]  ← overlap ~30 giây / 2–3 turns
Chunk 3: [35:30 → 54:00]  ← overlap ~30 giây / 2–3 turns
```

Overlap tránh mất ngữ cảnh ở điểm nối giữa các chunk.

### Prompt cho từng chunk

```
Đây là đoạn transcript từ phút {start} đến phút {end} của cuộc họp.
[Nếu không phải chunk đầu: "Tóm tắt đoạn trước: {prev_summary}"]

Transcript:
---
{chunk_text}
---

Hãy tóm tắt ngắn gọn đoạn này, liệt kê action items và decisions nếu có.
```

### Merge summary cuối

```
Dưới đây là các tóm tắt từng phần của cuộc họp:
---
{summary_1}
{summary_2}
...
---

Hãy tổng hợp thành 1 meeting notes hoàn chỉnh gồm:
- Tóm tắt chính
- Action items (tất cả các phần)
- Decisions
```

## Ví dụ thực tế

```text
Meeting 2 tiếng, tiếng Việt
→ ~60.000 tokens → cần chunk
→ Chia thành 6 chunk × 20 phút
→ 6 lần gọi AI → 6 summary
→ 1 lần gọi AI merge → Final summary
→ Tổng: 7 API calls
```

---

# 12. Google Calendar Integration

## Cách hoạt động

- Chrome Identity API OAuth2
- Match Calendar event theo thời gian meeting
- Append summary vào event description

---

# 13. Meeting History

## Storage Strategy

Dùng hai tầng lưu trữ, mỗi tầng lưu đúng loại data của nó:

| Tầng | Công nghệ | Lưu gì |
|------|-----------|--------|
| Dữ liệu lớn | `IndexedDB` | Transcript raw + Meeting metadata |
| Config nhỏ | `chrome.storage.local` | Settings, preferences, recent IDs |

```
IndexedDB (meet-assistant)
├── Store: transcripts       ← dữ liệu lớn, không giới hạn
│   ├── id (meetingId)
│   ├── lines[] { speaker, text, ts }
│   └── createdAt
│
└── Store: meetings          ← metadata đầy đủ
    ├── id (meetingId)
    ├── title
    ├── summary
    ├── actionItems[]
    ├── decisions[]
    ├── summaryStatus        ← pending | processing | completed | failed
    ├── calendarEventId
    ├── duration (seconds)
    └── createdAt

chrome.storage.local
├── settings                 ← API endpoint, key, model, caption mode
├── recentMeetingIds[]       ← danh sách ID để load nhanh History
└── userPreferences          ← ngôn ngữ, summary prefs, data retention
```

### Tại sao IndexedDB thay vì SQLite

- **Built-in** — không cần thêm dependency hay WASM binary (~500KB–1.5MB)
- **Không giới hạn** thực tế (chrome.storage.local giới hạn 5MB)
- **Đủ dùng** — use case chỉ cần read by ID + list recent, không cần SQL phức tạp

---

# 14. IndexedDB Migration Strategy

Khi extension update và schema thay đổi, cần migration tự động để không làm mất data của user.

## Versioning

```javascript
const DB_VERSION = 1; // tăng lên mỗi khi schema thay đổi

const request = indexedDB.open('meet-assistant', DB_VERSION);

request.onupgradeneeded = (event) => {
  const oldVersion = event.oldVersion;
  const db = event.target.result;

  if (oldVersion < 1) {
    // Tạo schema ban đầu
    db.createObjectStore('transcripts', { keyPath: 'id' });
    db.createObjectStore('meetings', { keyPath: 'id' });
  }

  if (oldVersion < 2) {
    // Ví dụ migration v1 → v2: thêm index cho createdAt
    const store = event.target.transaction.objectStore('meetings');
    store.createIndex('createdAt', 'createdAt');
  }

  if (oldVersion < 3) {
    // Ví dụ v2 → v3: thêm field summaryStatus với default value
    // (backfill sẽ chạy sau khi DB mở xong)
  }
};
```

## Nguyên tắc migration

- **Không xóa data cũ** trong migration — chỉ thêm field hoặc index mới
- **Backfill default value** cho field mới nếu cần (chạy sau khi open DB)
- **Tăng `DB_VERSION`** mỗi khi có thay đổi schema
- **Test migration** trên data cũ trước khi release

---

# 15. Security & Privacy

## API Key

- Lưu local
- Không gửi lên server trung gian
- Chỉ gửi trực tiếp tới endpoint user cấu hình

---

## Transcript Data

- Transcript chỉ lưu local
- Chỉ gửi khi user nhấn summarize
- Không có backend collect data

---

## Consent Notice

Lần đầu dùng:

```text
Extension này có thể capture transcript cuộc họp.
Hãy đảm bảo bạn có quyền ghi nhận nội dung cuộc họp theo chính sách công ty.
```

---

# 16. Error Handling & Retry

## AI API Failures

```text
Gọi AI API thất bại
→ Phân loại lỗi:
    - 401 Unauthorized    → "Sai API key, kiểm tra lại Settings"
    - 429 Rate Limited    → Tự retry sau 5–10 giây (tối đa 3 lần)
    - 413 / context error → Tự giảm chunk size và retry
    - 5xx Server Error    → Retry với exponential backoff
    - Network timeout     → Retry 1 lần, sau đó thông báo user
→ Dù lỗi vẫn luôn lưu transcript vào IndexedDB
→ User có thể vào History và nhấn "Summarize lại" bất kỳ lúc nào
```

## Retry Logic

```text
Attempt 1 → fail → đợi 3s
Attempt 2 → fail → đợi 8s
Attempt 3 → fail → hiện lỗi, cho user chọn retry thủ công
```

## Summary Status

Mỗi meeting trong IndexedDB có trường `summaryStatus` để History biết trạng thái:

| Status | Ý nghĩa | Hiển thị trong History |
|--------|---------|------------------------|
| `pending` | Transcript đang được capture, chưa summarize | "Đang ghi..." |
| `processing` | Đang gọi AI API | "Đang tóm tắt..." |
| `completed` | Summary xong | Hiện summary + action items |
| `failed` | Gọi AI thất bại | "Lỗi — [Thử lại]" |

Meeting có status `failed` hoặc `pending` đều cho phép retry từ History.

## UX khi lỗi

```
⚠️  Tóm tắt thất bại: Rate limit exceeded
    Transcript đã được lưu lại.
    [Thử lại]  [Xem transcript]
```

---

# 17. Manifest Permissions

Khai báo đầy đủ trước khi build để tránh bị reject khi submit Chrome Web Store.

```json
{
  "permissions": [
    "storage",
    "identity",
    "tabs",
    "activeTab",
    "offscreen"
  ],
  "host_permissions": [
    "https://meet.google.com/*",
    "https://www.googleapis.com/*"
  ]
}
```

## Nguyên tắc

- **Không xin permission thừa** — Chrome Web Store review sẽ hỏi lý do từng permission
- `identity` — cần cho Chrome Identity API (Google OAuth)
- `offscreen` — cần cho Phase 2 nếu có audio recording
- `host_permissions` cho `googleapis.com` — cần để gọi Google Calendar API

---

# 18. Share Summary

Sau khi AI tóm tắt xong, user thường cần chia sẻ ngay cho team. Cung cấp 3 hình thức:

```
✅ Summary hoàn tất

[📋 Copy Markdown]  [✉️ Copy Plain Text]  [📤 Export .md]
```

## Sự khác biệt giữa các format

| Format | Dùng cho | Ví dụ |
|--------|---------|-------|
| Copy Markdown | Notion, GitHub, Obsidian | `## Action Items\n- [ ] ...` |
| Copy Plain Text | Gmail, Outlook, Slack, chat | Không có `##`, `**`, `- [ ]` — thuần text |
| Export .md | Lưu file, chia sẻ qua Drive | Download file `.md` |

"Copy Plain Text" là quan trọng nhất trong thực tế — dán vào email không bị ký tự lạ.

---

# 19. Technical Risks

| Risk | Giải pháp |
|------|-----------|
| Google Meet đổi DOM | Fallback selectors, monitor DOM version |
| Caption không bật | Caption mode + reminder |
| Duplicate transcript | Debounce + merge + hash dedup |
| Transcript quá dài | Token estimation + speaker-aware chunking |
| AI API thất bại | Retry + exponential backoff + lưu transcript local |
| IndexedDB đầy | Tự động xóa meetings cũ nhất khi > 500MB |
| OAuth phức tạp | Tách Phase 2, không block MVP |
| CORS custom API | User tự cấu hình endpoint, không proxy qua server |

---

# 20. Roadmap

## Phase 1 — MVP

## Features

- Extension scaffold
- Options page
- Caption capture
- AI summary
- Export markdown
- Local history

## Chưa cần

- Backend
- Audio recording
- Speaker diarization

## Timeline

```text
2–3 tuần
```

---

# Phase 2 — Google Calendar

- OAuth2
- Calendar sync
- Append summary vào event

Timeline:

```text
1 tuần
```

---

# Phase 3 — UX Polish

- Provider presets
- API test button
- Search history
- Notifications
- Better popup UI

Timeline:

```text
1 tuần
```

---

# Phase 4 — Audio Recording (Optional)

## Chỉ dùng khi CC không đủ

- tabCapture
- MediaRecorder
- Whisper API
- Speaker diarization

Timeline:

```text
2–3 tuần
```

---

# 21. MVP Recommendation

## Nên làm trước

```text
✓ Caption Capture
✓ AI Summary
✓ Export Markdown
✓ Local History
✓ User-configurable API
```

## Chưa cần

```text
✗ Audio Recording
✗ Backend
✗ Speaker Diarization
✗ Team Collaboration
```

---

# 22. Định hướng tương lai

Có thể mở rộng:

- Zoom
- Microsoft Teams
- Slack summary
- Notion integration
- Jira integration

---

# 23. Kết luận

## Điểm mạnh chính

- Không backend
- Privacy-first
- User tự dùng API key
- Chi phí gần như bằng 0
- Dễ build MVP
- Dễ mở rộng

## Hướng triển khai tốt nhất

```text
Google Meet CC
→ AI Summary
→ Local History
→ Google Calendar
→ Audio Backup (optional)
```
