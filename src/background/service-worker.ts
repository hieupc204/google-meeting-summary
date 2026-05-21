import {
  appendTranscriptEntries,
  deleteMeeting,
  deleteTranscriptsBefore,
  getMeeting,
  getTranscript,
  listRecentMeetings,
  saveAudioBlob,
  saveMeeting,
  upsertTranscriptLine,
} from '@/shared/db';
import { getSettings, pushRecentMeetingId } from '@/shared/storage';
import { summarizeMeeting } from '@/shared/ai';
import type {
  CaptureStatus,
  Message,
  MeetingRecord,
  RecordingStatus,
  TranscriptLine,
} from '@/shared/types';

interface ActiveSession {
  meetingId: string;
  title: string;
  startedAt: number;
  state: CaptureStatus['state'];
}

// MV3 service workers get terminated after ~30s idle, so module-level vars
// reset. Persist the active session to chrome.storage.session so popup
// queries after a restart still see "in meeting".
const ACTIVE_KEY = 'activeSession';

async function loadActive(): Promise<ActiveSession | null> {
  const r = await chrome.storage.session.get(ACTIVE_KEY);
  return (r[ACTIVE_KEY] as ActiveSession | undefined) ?? null;
}

async function saveActive(a: ActiveSession | null): Promise<void> {
  if (a) await chrome.storage.session.set({ [ACTIVE_KEY]: a });
  else await chrome.storage.session.remove(ACTIVE_KEY);
}

async function patchActive(meetingId: string, patch: Partial<ActiveSession>) {
  const cur = await loadActive();
  if (cur?.meetingId !== meetingId) return;
  await saveActive({ ...cur, ...patch });
}

async function ensureMeeting(meetingId: string, title: string): Promise<MeetingRecord> {
  const existing = await getMeeting(meetingId);
  if (existing) return existing;
  const now = Date.now();
  const meeting: MeetingRecord = {
    id: meetingId,
    title,
    actionItems: [],
    decisions: [],
    pendingIssues: [],
    summaryStatus: 'pending',
    duration: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveMeeting(meeting);
  await pushRecentMeetingId(meetingId);
  return meeting;
}

async function handleCaptureLine(meetingId: string, line: TranscriptLine) {
  const tagged: TranscriptLine = { ...line, source: line.source ?? 'text' };
  if (tagged.blockId) {
    await upsertTranscriptLine(meetingId, tagged);
  } else {
    await appendTranscriptEntries(meetingId, [tagged]);
  }
  await patchActive(meetingId, { state: 'capturing' });
}

async function handleSummarize(meetingId: string) {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return { ok: false, error: 'Meeting not found' };
  meeting.summaryStatus = 'processing';
  meeting.summaryError = undefined;
  meeting.updatedAt = Date.now();
  await saveMeeting(meeting);
  try {
    const [transcript, settings] = await Promise.all([
      getTranscript(meetingId),
      getSettings(),
    ]);
    const result = await summarizeMeeting(meeting, transcript ?? null, settings);
    meeting.summary = result.summary;
    meeting.actionItems = result.actionItems;
    meeting.decisions = result.decisions;
    meeting.pendingIssues = result.pendingIssues;
    meeting.draftEmail = result.draftEmail;
    meeting.keywords = result.keywords;
    meeting.meetingDate = result.meetingDate;
    meeting.meetingTime = result.meetingTime;
    meeting.meetingFormat = result.meetingFormat;
    meeting.participants = result.participants;
    meeting.chair = result.chair;
    meeting.objective = result.objective;
    meeting.summaryStatus = 'completed';
    meeting.updatedAt = Date.now();
    const freshOk = await getMeeting(meetingId);
    if (freshOk?.audio) meeting.audio = freshOk.audio;
    await saveMeeting(meeting);
    return { ok: true };
  } catch (e) {
    meeting.summaryStatus = 'failed';
    meeting.summaryError = (e as Error).message ?? String(e);
    meeting.updatedAt = Date.now();
    const freshErr = await getMeeting(meetingId);
    if (freshErr?.audio) meeting.audio = freshErr.audio;
    await saveMeeting(meeting);
    return { ok: false, error: meeting.summaryError };
  }
}

async function getStatus(): Promise<CaptureStatus> {
  const active = await loadActive();
  if (!active) return { state: 'idle', lineCount: 0 };
  // Derive lineCount from the transcript record so it stays accurate after
  // SW restarts (where in-memory counters would be lost).
  const t = await getTranscript(active.meetingId);
  const lineCount = t?.lines.filter(
    (e) => (e as TranscriptLine).hash !== undefined,
  ).length ?? 0;
  return {
    meetingId: active.meetingId,
    title: active.title,
    state: active.state,
    lineCount,
    startedAt: active.startedAt,
  };
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'CAPTURE_START': {
        await ensureMeeting(msg.meetingId, msg.title);
        // Preserve startedAt across SW restart (a re-START on the same meeting
        // shouldn't reset the elapsed timer).
        const prev = await loadActive();
        await saveActive({
          meetingId: msg.meetingId,
          title: msg.title,
          startedAt: prev?.meetingId === msg.meetingId ? prev.startedAt : Date.now(),
          state: 'waiting',
        });
        sendResponse({ ok: true });
        break;
      }
      case 'CAPTURE_LINE': {
        await handleCaptureLine(msg.meetingId, msg.line);
        sendResponse({ ok: true });
        break;
      }
      case 'CAPTURE_PAUSE': {
        await appendTranscriptEntries(msg.meetingId, [
          { type: 'pause', from: msg.at, to: msg.at },
        ]);
        await patchActive(msg.meetingId, { state: 'paused' });
        sendResponse({ ok: true });
        break;
      }
      case 'CAPTURE_RESUME': {
        await patchActive(msg.meetingId, { state: 'capturing' });
        sendResponse({ ok: true });
        break;
      }
      case 'CAPTURE_END': {
        const cur = await loadActive();
        if (cur?.meetingId === msg.meetingId) {
          const m = await getMeeting(msg.meetingId);
          if (m) {
            m.duration = Math.round((Date.now() - cur.startedAt) / 1000);
            m.updatedAt = Date.now();
            await saveMeeting(m);
          }
          await saveActive(null);
        }
        const rec = await loadRecording();
        if (rec?.state === 'recording' && rec.meetingId === msg.meetingId) {
          await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => undefined);
          await saveRecording({ ...rec, state: 'finalizing' });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'SUMMARIZE': {
        const r = await handleSummarize(msg.meetingId);
        sendResponse(r);
        break;
      }
      case 'GET_STATUS':
        sendResponse(await getStatus());
        break;
      case 'GET_MEETING':
        sendResponse(await getMeeting(msg.meetingId));
        break;
      case 'LIST_MEETINGS':
        sendResponse(await listRecentMeetings(msg.limit));
        break;
      case 'DELETE_MEETING':
        await deleteMeeting(msg.meetingId);
        sendResponse({ ok: true });
        break;
      case 'MAIN_WORLD_CLICK_CC': {
        // Run a click in the page's MAIN world. Synthetic events fired
        // from the content-script's isolated world are silently dropped
        // by Meet's jsaction handlers, so we hop into the page context.
        const tabId = _sender.tab?.id;
        if (!tabId) {
          sendResponse({ ok: false, error: 'No tab id' });
          break;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              const labels = ['Bật phụ đề', 'Turn on captions', 'Turn captions on'];
              for (const lbl of labels) {
                const btn = document.querySelector(
                  `button[aria-label="${lbl}"], [role="button"][aria-label="${lbl}"]`,
                ) as HTMLElement | null;
                if (btn) {
                  btn.click();
                  return { clicked: true, label: lbl };
                }
              }
              // Fallback: any button with closed_caption icon variants.
              const icons = document.querySelectorAll('i.google-symbols, i.notranslate');
              for (const i of icons) {
                const t = (i.textContent || '').trim();
                if (
                  t === 'closed_caption' ||
                  t === 'closed_caption_off' ||
                  t === 'closed_caption_disabled'
                ) {
                  const btn = i.closest('button, [role="button"]') as HTMLElement | null;
                  if (btn) {
                    btn.click();
                    return { clicked: true, label: btn.getAttribute('aria-label') ?? '' };
                  }
                }
              }
              return { clicked: false };
            },
          });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        break;
      }
      default: {
        const r = await handleRecordingMessage(msg as { type: string } & Record<string, unknown>);
        if (r === undefined) sendResponse({ ok: false, error: 'Unknown message' });
        else sendResponse(r);
      }
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});

// Retention: run on startup + once per day via alarm
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('retention', { periodInMinutes: 60 * 24 });
});

chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'retention') return;
  const settings = await getSettings();
  if (settings.retentionDays === 0) return;
  const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
  await deleteTranscriptsBefore(cutoff);
});

// ──────────────────────────────────────────────────────────────────────
// Audio recording orchestration
// ──────────────────────────────────────────────────────────────────────

const REC_KEY = 'recordingState';
const OFFSCREEN_URL = chrome.runtime.getURL('src/offscreen/index.html');

// Note: MV3 service workers do NOT have URL.createObjectURL. Chunks live in
// the offscreen document; on stop, offscreen assembles the Blob, creates an
// object URL there, and passes that URL here for chrome.downloads.download.

async function loadRecording(): Promise<RecordingStatus | null> {
  const r = await chrome.storage.session.get(REC_KEY);
  return (r[REC_KEY] as RecordingStatus | undefined) ?? null;
}

async function saveRecording(s: RecordingStatus | null): Promise<void> {
  if (s) await chrome.storage.session.set({ [REC_KEY]: s });
  else await chrome.storage.session.remove(REC_KEY);
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Recording meeting audio (tab + mic)',
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function audioFilename(meeting: MeetingRecord): string {
  const d = new Date(meeting.createdAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `MeetAssistant/${date}_${slugify(meeting.title)}_${meeting.id}.webm`;
}

function sidecarFilename(audioName: string): string {
  return audioName.replace(/\.webm$/, '.json');
}

// Resolve when chrome.downloads reports this id is complete/interrupted.
// blob: URLs live in the offscreen document — closing offscreen before the
// download finishes invalidates the URL and aborts the file.
function waitForDownload(downloadId: number): Promise<chrome.downloads.DownloadItem['state']> {
  return new Promise((resolve) => {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return;
      const s = delta.state.current;
      if (s === 'complete' || s === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(s);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // Safety net — if onChanged never fires, poll once after a delay.
    chrome.downloads.search({ id: downloadId }, (items) => {
      const cur = items?.[0]?.state;
      if (cur === 'complete' || cur === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(cur);
      }
    });
  });
}

async function handleRecordingStart(meetingId: string, tabId: number, includeMic: boolean) {
  const existing = await loadRecording();
  if (existing && existing.state !== 'idle') {
    return { ok: false, error: 'Recording already active' };
  }
  // getMediaStreamId must run in SW or extension page — returns a token the
  // offscreen doc passes into getUserMedia.
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message ?? 'Failed to get media stream id'));
      } else resolve(id);
    });
  });

  await ensureOffscreen();

  // Wait briefly for offscreen to be ready, then send START.
  await new Promise((r) => setTimeout(r, 200));
  const startResp = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START',
    streamId,
    includeMic,
  });
  if (!startResp?.ok) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
    return { ok: false, error: startResp?.error ?? 'Failed to start offscreen recording' };
  }

  const status: RecordingStatus = {
    state: 'recording',
    meetingId,
    startedAt: Date.now(),
  };
  await saveRecording(status);
  return { ok: true };
}

async function finalizeRecording(
  blobUrl: string,
  durationMs: number,
  sizeBytes: number,
  mimeTypeFinal: string,
) {
  console.log('[SW] finalizeRecording start', { sizeBytes, durationMs, mimeTypeFinal, blobUrl });
  const rec = await loadRecording();
  if (!rec?.meetingId) {
    console.warn('[SW] finalizeRecording: no recording state, aborting');
    await saveRecording(null);
    return;
  }
  const meeting = await getMeeting(rec.meetingId);
  if (!meeting) {
    console.warn('[SW] finalizeRecording: meeting not found', rec.meetingId);
    await saveRecording(null);
    return;
  }

  // Fetch the blob into the SW so we can persist it to IndexedDB for
  // in-app playback. MUST run before closeDocument() — the blob: URL is
  // hosted by the offscreen document and gets revoked when it closes.
  let inlineSaved = false;
  try {
    const resp = await fetch(blobUrl);
    const blob = await resp.blob();
    await saveAudioBlob(meeting.id, blob, mimeTypeFinal);
    inlineSaved = true;
    console.log('[SW] audio blob saved to IndexedDB', { meetingId: meeting.id, size: blob.size });
  } catch (e) {
    console.error('[SW] failed to save audio blob to IDB', e);
  }

  const audioName = audioFilename(meeting);
  let downloadId: number | undefined;
  try {
    downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: audioName,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    // Wait for the audio file to finish writing before we close offscreen
    // (which would revoke the blob: URL and abort an in-flight download).
    const finalState = await waitForDownload(downloadId);
    if (finalState !== 'complete') {
      throw new Error(`audio download ${finalState}`);
    }
    // Sidecar JSON via data URL — small, and SW can't make object URLs.
    const sidecar = {
      meetingId: meeting.id,
      title: meeting.title,
      startedAt: rec.startedAt,
      durationMs,
      sizeBytes,
      mimeType: mimeTypeFinal,
    };
    const sidecarUrl =
      'data:application/json;base64,' +
      btoa(unescape(encodeURIComponent(JSON.stringify(sidecar, null, 2))));
    await chrome.downloads.download({
      url: sidecarUrl,
      filename: sidecarFilename(audioName),
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch (e) {
    console.error('[SW] download failed', e);
    const cur = await loadRecording();
    if (cur) await saveRecording({ ...cur, state: 'idle', error: String(e) });
  }

  const audioRecord = {
    storage: 'downloads' as const,
    filename: audioName,
    downloadId,
    startedAt: rec.startedAt ?? Date.now() - durationMs,
    durationMs,
    sizeBytes,
    mimeType: mimeTypeFinal,
    hasInlineBlob: inlineSaved,
  };
  const fresh = (await getMeeting(meeting.id)) ?? meeting;
  fresh.audio = audioRecord;
  fresh.updatedAt = Date.now();
  await saveMeeting(fresh);
  console.log('[SW] audio saved to meeting', { meetingId: fresh.id, audio: audioRecord });
  await saveRecording(null);
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

async function handleRecordingMessage(msg: { type: string } & Record<string, unknown>): Promise<unknown> {
  switch (msg.type) {
    case 'RECORDING_START':
      return handleRecordingStart(
        msg.meetingId as string,
        msg.tabId as number,
        msg.includeMic !== false,
      );
    case 'RECORDING_STOP': {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => undefined);
      const rec = await loadRecording();
      if (rec) await saveRecording({ ...rec, state: 'finalizing' });
      return { ok: true };
    }
    case 'RECORDING_STATUS':
      return (await loadRecording()) ?? { state: 'idle' };
    case 'OFFSCREEN_DONE':
      await finalizeRecording(
        msg.blobUrl as string,
        msg.durationMs as number,
        msg.sizeBytes as number,
        msg.mimeType as string,
      );
      return { ok: true };
    case 'OFFSCREEN_ERROR': {
      const rec = await loadRecording();
      if (rec) await saveRecording({ ...rec, state: 'idle', error: msg.error as string });
      await chrome.offscreen.closeDocument().catch(() => undefined);
      return { ok: true };
    }
    case 'OFFSCREEN_READY':
      return { ok: true };
    default:
      return undefined;
  }
}
