import { useEffect, useMemo, useState } from 'preact/hooks';
import type { CaptureStatus, Message, RecordingStatus } from '@/shared/types';
import {
  getHideMeetCC,
  getPanelMode,
  setHideMeetCC,
  setPanelMode,
  watchHideMeetCC,
  watchPanelMode,
  type PanelMode,
} from '@/shared/storage';

const STATE_TEXT: Record<CaptureStatus['state'], string> = {
  idle: 'Chưa có cuộc họp',
  waiting: 'Trong cuộc họp · Thời lượng',
  capturing: 'Đang ghi · Thời lượng',
  paused: 'Tạm dừng · Thời lượng',
  'no-cc': 'Phụ đề chưa bật · Thời lượng',
};

const MEET_URL_RE = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/;

function formatHMS(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function sendMsg<T = unknown>(msg: Message): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function Popup() {
  const [status, setStatus] = useState<CaptureStatus>({ state: 'idle', lineCount: 0 });
  const [recording, setRecording] = useState<RecordingStatus>({ state: 'idle' });
  const [meetTabId, setMeetTabId] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [panelMode, setPanelModeState] = useState<PanelMode>('hidden');
  const [hideMeetCC, setHideMeetCCState] = useState(false);
  // Meeting ID derived from the active tab URL — used to enable "Bắt đầu ghi"
  // when user is on a Meet page but the capture session is currently inactive.
  const [meetTabMeetingId, setMeetTabMeetingId] = useState<string | null>(null);

  useEffect(() => {
    const detect = () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        const url = tab?.url ?? '';
        const m = url.match(MEET_URL_RE);
        setMeetTabMeetingId(m?.[1] ?? null);
        setMeetTabId(m && tab?.id != null ? tab.id : null);
      });
    };
    detect();
    const id = setInterval(detect, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getPanelMode().then(setPanelModeState);
    getHideMeetCC().then(setHideMeetCCState);
    const off1 = watchPanelMode(setPanelModeState);
    const off2 = watchHideMeetCC(setHideMeetCCState);
    return () => {
      off1();
      off2();
    };
  }, []);

  const toggleHideMeetCC = async () => {
    const next = !hideMeetCC;
    await setHideMeetCC(next);
    setHideMeetCCState(next);
  };

  const togglePanel = async () => {
    const next: PanelMode = panelMode === 'full' ? 'hidden' : 'full';
    await setPanelMode(next);
    setPanelModeState(next);
    // When opening the slide, close the popup so the user sees it immediately.
    if (next === 'full') window.close();
  };

  useEffect(() => {
    const tick = async () => {
      const [s, r] = await Promise.all([
        sendMsg<CaptureStatus>({ type: 'GET_STATUS' }),
        sendMsg<RecordingStatus>({ type: 'RECORDING_STATUS' }),
      ]);
      setStatus(s);
      setRecording(r);
      setNow(Date.now());
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);

  const elapsed = useMemo(() => {
    if (!status.startedAt) return 0;
    return Math.floor((now - status.startedAt) / 1000);
  }, [now, status.startedAt]);

  const lineCount = status.lineCount;

  const onPause = () =>
    status.meetingId &&
    sendMsg({ type: 'CAPTURE_PAUSE', meetingId: status.meetingId, at: Date.now() });
  const onResume = () =>
    status.meetingId &&
    sendMsg({ type: 'CAPTURE_RESUME', meetingId: status.meetingId, at: Date.now() });
  const onEnd = async () => {
    if (!status.meetingId) return;
    await sendMsg({ type: 'CAPTURE_END', meetingId: status.meetingId });
    await sendMsg({ type: 'SUMMARIZE', meetingId: status.meetingId });
  };
  const onStopOnly = async () => {
    if (!status.meetingId) return;
    await sendMsg({ type: 'CAPTURE_END', meetingId: status.meetingId });
    // Refresh status immediately so UI flips to "start" mode.
    const s = await sendMsg<CaptureStatus>({ type: 'GET_STATUS' });
    setStatus(s);
  };
  const onAudioStart = async () => {
    if (!status.meetingId || !meetTabId) return;
    // Trigger mic permission prompt under a real user gesture (popup click).
    // Offscreen documents can't show the prompt themselves on chrome-extension
    // origins, so we ask here, stop the local stream, then start the actual
    // recording in the offscreen doc — the granted permission persists for
    // the extension origin.
    let includeMic = true;
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      includeMic = false;
      const proceed = confirm(
        `Không thể cấp quyền micro (${(e as Error).message}).\n\nTiếp tục ghi chỉ âm thanh tab?`,
      );
      if (!proceed) return;
    }
    const r = await sendMsg<{ ok: boolean; error?: string }>({
      type: 'RECORDING_START',
      meetingId: status.meetingId,
      tabId: meetTabId,
      includeMic,
    });
    if (!r?.ok) alert(`Không thể bắt đầu ghi âm: ${r?.error ?? 'unknown'}`);
    const rec = await sendMsg<RecordingStatus>({ type: 'RECORDING_STATUS' });
    setRecording(rec);
  };
  const onAudioStop = async () => {
    await sendMsg({ type: 'RECORDING_STOP' });
    const rec = await sendMsg<RecordingStatus>({ type: 'RECORDING_STATUS' });
    setRecording(rec);
  };
  const recElapsed = useMemo(() => {
    if (recording.state !== 'recording' || !recording.startedAt) return 0;
    return Math.floor((now - recording.startedAt) / 1000);
  }, [now, recording]);

  const onStartRecording = async () => {
    if (!meetTabMeetingId) return;
    const title = `Meeting ${new Date().toLocaleString('vi-VN')}`;
    await sendMsg({
      type: 'CAPTURE_START',
      meetingId: meetTabMeetingId,
      title,
    });
    // Refresh status — service worker now has an active session.
    const s = await sendMsg<CaptureStatus>({ type: 'GET_STATUS' });
    setStatus(s);
  };
  const openSection = (section: string) =>
    chrome.tabs.create({
      url: chrome.runtime.getURL(`src/history/index.html#${section}`),
    });
  const openOptions = () => openSection('ai');
  const openHistory = () => openSection('history');

  return (
    <>
      <div class="header">
        <div class="logo">
          <img class="logo-icon" src={chrome.runtime.getURL('icons/icon-128.png')} alt="" />
          Meet Assistant
        </div>
        <div class="header-actions">
          <button class="icon-btn" title="Lịch sử cuộc họp" onClick={openHistory}>
            🕐
          </button>
          <button class="icon-btn" title="Cài đặt" onClick={openOptions}>
            ⚙️
          </button>
        </div>
      </div>

      <div class={`status-bar ${status.state}`}>
        <div class="status-left">
          <div class="status-dot" />
          <span>{STATE_TEXT[status.state]}</span>
        </div>
        {status.startedAt && status.state !== 'idle' && (
          <span class="status-timer">{formatHMS(elapsed)}</span>
        )}
      </div>

      {status.title && (
        <div class="meeting-info">
          <div class="meeting-title">{status.title}</div>
          <div class="meeting-meta">
            <span>📅 {new Date(status.startedAt ?? Date.now()).toLocaleDateString()}</span>
            <span>🕐 {formatTime(status.startedAt ?? Date.now())}</span>
            <span>💬 {lineCount} dòng</span>
          </div>
        </div>
      )}

      {status.meetingId ? (
        <div class="controls">
          {status.state === 'paused' ? (
            <button class="btn btn-resume" onClick={onResume}>
              ▶ Tiếp tục
            </button>
          ) : (
            <button class="btn btn-pause" onClick={onPause}>
              ⏸ Tạm dừng
            </button>
          )}
          <button class="btn btn-stop" onClick={onStopOnly}>
            ⏹ Dừng ghi
          </button>
        </div>
      ) : meetTabMeetingId ? (
        <div class="controls">
          <button
            class="btn btn-resume"
            style={{ gridColumn: '1 / -1' }}
            onClick={onStartRecording}
          >
            ● Bắt đầu ghi
          </button>
        </div>
      ) : null}

      {status.meetingId && (
        <div class="controls" style={{ marginTop: 8 }}>
          {recording.state === 'recording' ? (
            <button
              class="btn btn-stop"
              style={{ gridColumn: '1 / -1' }}
              onClick={onAudioStop}
            >
              ⏹ Dừng ghi âm · {formatHMS(recElapsed)}
            </button>
          ) : recording.state === 'finalizing' ? (
            <button class="btn btn-pause" style={{ gridColumn: '1 / -1' }} disabled>
              💾 Đang lưu file…
            </button>
          ) : (
            <button
              class="btn btn-resume"
              style={{ gridColumn: '1 / -1' }}
              onClick={onAudioStart}
              disabled={!meetTabId}
            >
              🎙️ Bắt đầu ghi âm (tab + mic)
            </button>
          )}
        </div>
      )}

      <div class="summarize-wrap">
        {status.meetingId && (
          <button
            class="btn-summarize"
            disabled={lineCount === 0}
            onClick={onEnd}
          >
            ✦ Kết thúc &amp; Tóm tắt
          </button>
        )}
        <button
          class="btn-summarize"
          style={{ marginTop: 8, background: panelMode === 'full' ? '#2ecc71' : '#3a3a40' }}
          onClick={togglePanel}
        >
          {panelMode === 'full' ? '✕ Tắt slide' : '📋 Hiện slide bên Meet'}
        </button>
        <button
          class="btn-summarize"
          style={{ marginTop: 8, background: hideMeetCC ? '#e67e22' : '#3a3a40' }}
          onClick={toggleHideMeetCC}
        >
          {hideMeetCC ? '👁 Hiện lại transcript Meet' : '🙈 Ẩn transcript Meet gốc'}
        </button>
      </div>

      <div class="footer">
        <div class="footer-links">
          <button class="footer-link" onClick={openHistory}>
            🕐 Lịch sử
          </button>
          <button class="footer-link" onClick={openOptions}>
            ⚙️ Cài đặt
          </button>
        </div>
        <span class="footer-version">v0.1.0</span>
      </div>
    </>
  );
}
