// Runs in offscreen document context. Handles MediaRecorder lifecycle for
// tab+mic audio capture. Service worker drives it via runtime messages.

interface StartPayload {
  streamId: string;
  includeMic: boolean;
}

let recorder: MediaRecorder | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let mixedStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let startedAt = 0;
let totalBytes = 0;
let mimeType = 'audio/webm;codecs=opus';
// Keep chunks here (DOM context has Blob/URL APIs). MV3 service workers don't
// expose URL.createObjectURL, so we MUST assemble + create the object URL
// from this offscreen document, then hand the URL to the SW for downloading.
let chunks: Blob[] = [];

async function startRecording(payload: StartPayload): Promise<void> {
  if (recorder) throw new Error('Already recording');

  // 1) Tab audio via streamId from SW.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error — legacy mandatory constraint required by tabCapture.
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: payload.streamId },
    },
    video: false,
  });

  // 2) Mic (optional). Failure shouldn't kill the recording — fall back to tab-only.
  if (payload.includeMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      console.warn('[offscreen] mic denied/unavailable, recording tab only', e);
      micStream = null;
    }
  }

  // 3) Mix streams via Web Audio. Also pipe tab back to destination so user
  //    can still hear Meet (tabCapture mutes the tab otherwise).
  audioContext = new AudioContext();
  const dest = audioContext.createMediaStreamDestination();
  audioContext.createMediaStreamSource(tabStream).connect(dest);
  audioContext.createMediaStreamSource(tabStream).connect(audioContext.destination);
  if (micStream) audioContext.createMediaStreamSource(micStream).connect(dest);
  mixedStream = dest.stream;

  // 4) MediaRecorder. Timeslice 30s so chunks stream out to SW and we never
  //    hold the whole meeting in memory here.
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'audio/webm';
  }
  recorder = new MediaRecorder(mixedStream, {
    mimeType,
    audioBitsPerSecond: 64_000,
  });
  chunks = [];
  totalBytes = 0;
  startedAt = Date.now();

  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    totalBytes += e.data.size;
    chunks.push(e.data);
  };
  recorder.onstop = () => {
    const finalMime = chunks[0]?.type || mimeType;
    const blob = new Blob(chunks, { type: finalMime });
    const blobUrl = URL.createObjectURL(blob);
    console.log('[offscreen] recorder stopped, sending OFFSCREEN_DONE', {
      chunks: chunks.length,
      totalBytes,
      durationMs: Date.now() - startedAt,
      mimeType: finalMime,
    });
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_DONE',
      blobUrl,
      sizeBytes: totalBytes,
      durationMs: Date.now() - startedAt,
      mimeType: finalMime,
    });
    chunks = [];
    cleanup();
  };
  recorder.onerror = (ev) => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_ERROR',
      error: (ev as ErrorEvent).message ?? 'MediaRecorder error',
    });
  };

  recorder.start(30_000);
}

function stopRecording(): void {
  if (!recorder) return;
  if (recorder.state !== 'inactive') recorder.stop();
}

function cleanup(): void {
  recorder = null;
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  audioContext?.close();
  tabStream = null;
  micStream = null;
  mixedStream = null;
  audioContext = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'OFFSCREEN_START') {
      try {
        await startRecording({ streamId: msg.streamId, includeMic: msg.includeMic });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message });
      }
    } else if (msg?.type === 'OFFSCREEN_STOP') {
      stopRecording();
      sendResponse({ ok: true });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
