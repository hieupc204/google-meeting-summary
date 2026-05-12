import {
  appendTranscriptEntries,
  deleteMeeting,
  deleteTranscriptsBefore,
  getMeeting,
  getTranscript,
  listRecentMeetings,
  saveMeeting,
  upsertTranscriptLine,
} from '@/shared/db';
import { getSettings, pushRecentMeetingId } from '@/shared/storage';
import { summarizeMeeting } from '@/shared/ai';
import type {
  CaptureStatus,
  Message,
  MeetingRecord,
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
  if (line.blockId) {
    await upsertTranscriptLine(meetingId, line);
  } else {
    await appendTranscriptEntries(meetingId, [line]);
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
    meeting.summaryStatus = 'completed';
    meeting.updatedAt = Date.now();
    await saveMeeting(meeting);
    return { ok: true };
  } catch (e) {
    meeting.summaryStatus = 'failed';
    meeting.summaryError = (e as Error).message ?? String(e);
    meeting.updatedAt = Date.now();
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
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
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
