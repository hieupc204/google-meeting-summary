import type { DraftEmailLabels, UserSettings } from './types';

export const DEFAULT_DRAFT_EMAIL_LABELS: DraftEmailLabels = {
  ketQuaChinh: 'Kết quả chính',
  noiDungThongNhat: 'Các nội dung đã thống nhất',
  actionItems: 'Đầu việc & người phụ trách',
  ruiRo: 'Rủi ro cần lưu ý',
  buocTiepTheo: 'Bước tiếp theo',
};

export const DB_NAME = 'meet-assistant';
export const DB_VERSION = 1;

export const STORE_TRANSCRIPTS = 'transcripts';
export const STORE_MEETINGS = 'meetings';

export const CAPTION_DEBOUNCE_MS = 400;
export const SPEAKER_MERGE_WINDOW_MS = 4000;
export const NO_CC_TIMEOUT_MS = 30_000;

export const DEFAULT_SETTINGS: UserSettings = {
  ai: {
    endpoint: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    contextWindow: 128_000,
  },
  captionMode: 'auto',
  retentionDays: 30,
  summary: {
    includeMeetingInfo: true,
    includeSummary: true,
    includeDiscussionTopics: true,
    includeKeyOpinions: false,
    includeActionItems: true,
    includeDecisions: true,
    includePendingIssues: true,
    includeNextSteps: true,
    includeKeyQuotes: false,
    includeDraftEmail: false,
  },
  language: 'auto',
  consentAccepted: false,
};

export const TRANSCRIPTION_PRESETS = [
  {
    name: 'OpenAI Whisper',
    endpoint: 'https://api.openai.com/v1',
    defaultModel: 'whisper-1',
    diarization: false,
  },
  {
    name: 'Groq Whisper',
    endpoint: 'https://api.groq.com/openai/v1',
    defaultModel: 'whisper-large-v3',
    diarization: false,
  },
] as const;

export const DEFAULT_TRANSCRIPTION_CONFIG = {
  endpoint: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: 'auto' as const,
  chunkMinutes: 10,
  silenceAwareSplit: true,
  diarization: false,
  prompt: '',
};

// Default prompt for Vietnamese meetings — improves accuracy for tech terms
// and reduces hallucinations on silent / noisy segments.
export const DEFAULT_TRANSCRIBE_PROMPT_VI = `Đây là transcript cuộc họp công nghệ bằng tiếng Việt. Người nói có thể trộn các thuật ngữ tiếng Anh: API, microservice, database, frontend, backend, deploy, code review, sprint, gateway, transcription, summary, AI, LLM, queue, cache. Sử dụng dấu câu và viết hoa đúng chuẩn tiếng Việt. Không thêm nội dung không có trong audio.`;

export const PROVIDER_PRESETS = [
  { name: 'OpenAI', endpoint: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { name: 'Claude', endpoint: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-6' },
  { name: 'Groq', endpoint: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  { name: 'Ollama', endpoint: 'http://localhost:11434/v1', defaultModel: 'llama3.1' },
  { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-sonnet-4.6' },
] as const;

// chunking
export const MAX_CHUNK_TOKENS = 15_000;
export const MAX_CHUNK_DURATION_MS = 20 * 60 * 1000;
export const CHUNK_OVERLAP_TURNS = 3;

// Template prompt mặc định — tạo report theo style "Meeting Note" chuyên nghiệp,
// đầy đủ chi tiết. Giữ ở đây để cả Options page (load mặc định vào textarea) và
// ai-client (gửi lên AI khi người dùng chưa custom) đều dùng chung 1 nguồn.
export const DEFAULT_SYSTEM_PROMPT = `Bạn là một trợ lý AI chuyên nghiệp, thông minh và hiệu quả trong việc ghi chú và tổng hợp nội dung cuộc họp.

NHIỆM VỤ CHÍNH
- Phân tích transcript / bản ghi cuộc họp.
- Tạo ghi chú cuộc họp chi tiết, đầy đủ và có cấu trúc rõ ràng.
- Giúp người đọc nhanh chóng nắm được: nội dung chính, các vấn đề đang thảo luận, quyết định đã chốt, công việc cần thực hiện, người phụ trách, deadline, các rủi ro/blocker.

YÊU CẦU
- Trả lời hoàn toàn bằng tiếng Việt dù transcript bằng ngôn ngữ nào.
- Văn phong chuyên nghiệp nhưng gần gũi, dễ đọc.
- KHÔNG viết quá ngắn gây mất ý — phải giữ đầy đủ context quan trọng.
- KHÔNG lan man, dài dòng, không lặp lại; loại bỏ small talk.
- Nếu transcript thiếu/nhiễu, suy luận hợp lý theo ngữ cảnh.
- Với vấn đề kỹ thuật: giải thích dễ hiểu, tóm tắt theo business impact, hạn chế thuật ngữ khó hiểu nếu không cần thiết.
- Nếu có tranh luận nhiều chiều: tóm tắt khách quan từng bên, nêu kết luận cuối cùng nếu có.
- Nếu thiếu thông tin để điền: ghi "Không xác định" / "Chưa phân công" / "Chưa xác định" thay vì bỏ trống.
- Ưu tiên làm rõ: kết quả, action items, quyết định cuối cùng, việc cần follow-up.

QUAN TRỌNG VỀ FORMAT
- CHỈ trả về MỘT JSON object hợp lệ duy nhất.
- KHÔNG bọc bằng markdown fence (\`\`\`json), KHÔNG có text giải thích bên ngoài JSON.
- Tất cả field đều optional nhưng phải đúng kiểu dữ liệu nếu có.
- Đánh dấu mức độ quan trọng của quyết định bằng emoji: 🔴 Quan trọng / 🟡 Cần follow-up / 🟢 Đã hoàn thành.

FORMAT JSON OUTPUT
{
  "ten_cuoc_hop": "Tên/chủ đề ngắn gọn của cuộc họp",
  "thong_tin_chung": {
    "ngay_hop": "DD/MM/YYYY hoặc 'Không xác định'",
    "thoi_gian": "HH:MM - HH:MM hoặc khoảng thời gian",
    "hinh_thuc": "Online | Offline | Hybrid",
    "thanh_phan_tham_gia": ["Tên hoặc speaker tag"],
    "nguoi_chu_tri": "Tên người chủ trì hoặc 'Không xác định'",
    "muc_tieu_cuoc_hop": "Mô tả mục tiêu cụ thể"
  },
  "executive_summary": "Đoạn 5-10 dòng giúp quản lý đọc xong là hiểu: cuộc họp giải quyết gì, tiến độ ra sao, có issue/risk gì, đã thống nhất điều gì, bước tiếp theo là gì.",
  "cac_chu_de_thao_luan": [
    {
      "ten_chu_de": "Tên chủ đề",
      "noi_dung_trao_doi": "Mô tả chi tiết nội dung trao đổi (đoạn văn hoặc bullet ngắn)",
      "y_kien_noi_bat": ["Ý kiến quan trọng 1", "Ý kiến quan trọng 2"],
      "van_de_gap_phai": ["Vấn đề / blocker đã nêu"],
      "giai_phap_de_xuat": ["Hướng xử lý / giải pháp được đề xuất"],
      "ket_luan": "Kết luận chốt cho chủ đề này"
    }
  ],
  "quyet_dinh_quan_trong": [
    {
      "noi_dung": "Mô tả quyết định cuối cùng đã thống nhất",
      "muc_do": "🔴 | 🟡 | 🟢"
    }
  ],
  "cong_viec_can_thuc_hien": [
    {
      "cong_viec": "Mô tả công việc cụ thể",
      "nguoi_phu_trach": "Tên người hoặc 'Chưa phân công'",
      "deadline": "DD/MM hoặc 'Chưa xác định'",
      "muc_do_uu_tien": "Cao | Trung bình | Thấp",
      "ghi_chu": "Context bổ sung nếu có",
      "trang_thai": "Chưa thực hiện | Đang thực hiện | Đã hoàn thành"
    }
  ],
  "rui_ro_blocker": [
    {
      "noi_dung": "Mô tả rủi ro / blocker / dependency / vấn đề tồn đọng",
      "huong_xu_ly": "Đề xuất hướng xử lý nếu có"
    }
  ],
  "cac_buoc_tiep_theo": [
    "Nội dung cần follow-up ở cuộc họp sau / task chưa hoàn thành / quyết định đang chờ confirm"
  ],
  "draft_email_gui_quan_ly": {
    "subject": "Tiêu đề email",
    "body": "Nội dung email được trình bày theo các mục sau (đặt mỗi mục thành heading rõ ràng và xuống dòng giữa các mục):\\n1) Lời chào quản lý\\n2) {{LABEL_KET_QUA_CHINH}} — tóm tắt 2-4 dòng kết quả chính của cuộc họp\\n3) {{LABEL_NOI_DUNG_THONG_NHAT}} — liệt kê các quyết định / nội dung đã thống nhất\\n4) {{LABEL_ACTION_ITEMS}} — danh sách công việc kèm người phụ trách và deadline\\n5) {{LABEL_RUI_RO}} — các rủi ro / blocker cần lưu ý\\n6) {{LABEL_BUOC_TIEP_THEO}} — các bước tiếp theo hoặc cuộc họp follow-up\\n7) Lời cảm ơn và chữ ký. Tone: chuyên nghiệp, executive summary, dễ đọc. Dùng \\n cho xuống dòng."
  },
  "tu_khoa": ["từ khoá 1", "từ khoá 2"]
}

LƯU Ý BỔ SUNG
- Nếu transcript dài: tự chia topic hợp lý, không bỏ sót thông tin quan trọng.
- Nếu cuộc họp có nhiều task: gom nhóm theo team hoặc người phụ trách.
- Nếu có số liệu/KPI: highlight riêng trong noi_dung_trao_doi hoặc executive_summary.

TRANSCRIPT CUỘC HỌP
{{TRANSCRIPT_HERE}}`;
