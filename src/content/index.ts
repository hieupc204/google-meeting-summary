import {
  getHideMeetCC,
  getPanelMode,
  getSettings,
  watchHideMeetCC,
  watchPanelMode,
  watchSettings,
} from '@/shared/storage';
import type { PanelMode } from '@/shared/storage';
import type { Message, TranscriptLine } from '@/shared/types';

const MEET_ID_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/;

function getMeetingId(): string | null {
  const m = location.pathname.match(MEET_ID_RE);
  return m?.[1] ?? null;
}

function getMeetingTitle(): string {
  const t = document.title.replace(/\s*[-–]\s*Google Meet.*$/i, '').trim();
  if (t && t.toLowerCase() !== 'meet') return t;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Meeting ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function send(msg: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

async function hashLine(speaker: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${speaker}|${normalize(text)}`);
  const buf = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let currentMeetingId: string | null = null;
const blockState = new WeakMap<Element, { id: string; speaker: string; norm: string }>();
const blockIds = new WeakMap<Element, string>();
let blockSeq = 0;
// Per-blockId state for the debug panel — same upsert semantics as DB.
const debugByBlock = new Map<string, TranscriptLine>();
const debugOrder: string[] = []; // preserves first-seen order
let debugRoot: ShadowRoot | null = null;
let debugBody: HTMLElement | null = null;
let rootObserver: MutationObserver | null = null;
let scanInterval: number | null = null;
let scanScheduled = false;

function getBlockId(el: Element): string {
  let id = blockIds.get(el);
  if (!id) {
    id = `b${++blockSeq}`;
    blockIds.set(el, id);
  }
  return id;
}

// ---------- Caption discovery ----------

// Find caption regions. Meet uses role="region" with aria-label "Phụ đề"/"Captions"
// (NOT aria-live). Container class .iOzk7 / jsname=dsyhDe. We try several selectors.
function findCaptionRegions(): Element[] {
  const regions = new Set<Element>();
  document
    .querySelectorAll('[role="region"][aria-label*="phụ đề" i], [role="region"][aria-label*="caption" i], [role="region"][aria-label*="subtitle" i]')
    .forEach((el) => regions.add(el));
  document.querySelectorAll('[jsname="dsyhDe"], .iOzk7').forEach((el) => regions.add(el));
  // Fallback: any container holding .nMcdL caption blocks.
  document.querySelectorAll('.nMcdL').forEach((el) => {
    if (el.parentElement) regions.add(el.parentElement);
  });
  return [...regions];
}

// Extract caption blocks from a region. A block is a direct-or-nested child whose
// textContent looks like "SPEAKER\nTEXT" or "SPEAKER TEXT". We recurse into
// the region's children up to depth 3 looking for elements that have BOTH a short
// header-like sub-element and longer body text.
interface ParsedBlock {
  block: Element;
  speaker: string;
  text: string;
}

function parseBlocksInRegion(region: Element): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  // Primary selectors based on Meet's current DOM:
  // .nMcdL = caption block, .NWpY1d = speaker name, .ygicle = caption text.
  const blocks = region.querySelectorAll('.nMcdL');
  for (const block of blocks) {
    const speakerEl = block.querySelector('.NWpY1d');
    const textEl = block.querySelector('.ygicle');
    const speaker = (speakerEl?.textContent ?? '').trim();
    const text = (textEl?.textContent ?? '').trim();
    if (!speaker || !text) continue;
    out.push({ block, speaker, text });
  }
  if (out.length > 0) return out;
  // Fallback: heuristic for unknown future DOM changes.
  const candidates: Element[] = [];
  region.querySelectorAll(':scope > div, :scope > div > div, :scope > div > div > div').forEach((el) =>
    candidates.push(el),
  );
  for (const block of candidates) {
    const children = Array.from(block.children).filter(
      (c) => (c.textContent ?? '').trim().length > 0,
    );
    if (children.length < 2) continue;
    const speaker = (children[0].textContent ?? '').trim();
    if (!speaker || speaker.length > 80 || speaker.includes('\n')) continue;
    const text = children.slice(1).map((c) => (c.textContent ?? '').trim()).join(' ').trim();
    if (!text || text.length < 2) continue;
    if (out.some((b) => b.block.contains(block))) continue;
    out.push({ block, speaker, text });
  }
  return out;
}

let lastProbeAt = 0;

// Triggered by MutationObserver. Coalesces bursts of mutations into one scan
// per microtask. Use queueMicrotask (not rAF) — rAF is heavily throttled when
// the Meet tab is in the background, which made early caption lines drop in
// long meetings.
function scheduleScan() {
  if (scanScheduled) return;
  scanScheduled = true;
  queueMicrotask(() => {
    scanScheduled = false;
    void scanCaptions();
  });
}

// Harvest a caption block that's about to leave the DOM. The element is still
// detached-but-alive inside the MutationRecord, so textContent is intact.
async function harvestRemovedBlock(block: Element) {
  if (!currentMeetingId) return;
  const speakerEl = block.querySelector?.('.NWpY1d');
  const textEl = block.querySelector?.('.ygicle');
  const speaker = (speakerEl?.textContent ?? '').trim();
  const text = (textEl?.textContent ?? '').trim();
  if (!speaker || !text) return;
  const norm = normalize(text);
  const prev = blockState.get(block);
  if (prev && prev.norm === norm && prev.speaker === speaker) return;
  const id = getBlockId(block);
  blockState.set(block, { id, speaker, norm });
  const hash = await hashLine(speaker, text);
  const ts = prev ? (debugByBlock.get(id)?.ts ?? Date.now()) : Date.now();
  const line: TranscriptLine = { speaker, text, ts, hash, blockId: id };
  if (!debugByBlock.has(id)) debugOrder.push(id);
  debugByBlock.set(id, line);
  renderDebug();
  await send({ type: 'CAPTURE_LINE', meetingId: currentMeetingId, line });
}

function harvestRemovedNodes(nodes: NodeList) {
  nodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const blocks = el.matches?.('.nMcdL')
      ? [el]
      : Array.from(el.querySelectorAll?.('.nMcdL') ?? []);
    for (const b of blocks) void harvestRemovedBlock(b);
  });
}

async function scanCaptions() {
  if (!currentMeetingId) return;
  const regions = findCaptionRegions();
  let totalBlocks = 0;
  for (const region of regions) {
    const blocks = parseBlocksInRegion(region);
    totalBlocks += blocks.length;
    for (const { block, speaker, text } of blocks) {
      const norm = normalize(text);
      const prev = blockState.get(block);
      if (prev && prev.norm === norm && prev.speaker === speaker) continue;
      const id = getBlockId(block);
      blockState.set(block, { id, speaker, norm });
      const hash = await hashLine(speaker, text);
      // First sighting: use now. Updates: keep original ts so the line
      // shows when the speaker started, not when the last word arrived.
      const ts = prev ? (debugByBlock.get(id)?.ts ?? Date.now()) : Date.now();
      const line: TranscriptLine = { speaker, text, ts, hash, blockId: id };
      if (!debugByBlock.has(id)) debugOrder.push(id);
      debugByBlock.set(id, line);
      renderDebug();
      await send({ type: 'CAPTURE_LINE', meetingId: currentMeetingId, line });
    }
  }
  if (Date.now() - lastProbeAt > 3000) {
    lastProbeAt = Date.now();
    setProbeInfo(`regions: ${regions.length} · blocks: ${totalBlocks}`);
  }
}

function probeDom(): string {
  const lines: string[] = [];
  const regions = findCaptionRegions();
  lines.push(`aria-live regions: ${regions.length}`);
  regions.forEach((r, i) => {
    const tag = r.tagName.toLowerCase();
    const cls = (r.getAttribute('class') ?? '').slice(0, 60);
    const text = (r.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    lines.push(`  [${i}] <${tag} class="${cls}"> children=${r.children.length}`);
    lines.push(`      text: ${text || '(empty)'}`);
    const blocks = parseBlocksInRegion(r);
    lines.push(`      parsed blocks: ${blocks.length}`);
    blocks.slice(0, 3).forEach((b, j) => {
      lines.push(`        #${j} ${b.speaker}: ${b.text.slice(0, 100)}`);
    });
  });
  return lines.join('\n');
}

// ---------- Auto-enable CC ----------

const CC_LABEL_RE = /caption|subtitle|phụ\s?đề/i;

const CC_ICON_VARIANTS = new Set([
  'closed_caption',
  'closed_caption_off',
  'closed_caption_disabled',
]);

function findCCButton(): HTMLButtonElement | null {
  // Strategy 1: button containing a CC Material Symbol icon. The text is
  // `closed_caption` when ON and `closed_caption_off` / `_disabled` when
  // OFF — must match both so we can find the toggle in either state.
  const icons = document.querySelectorAll('i.google-symbols, i.notranslate');
  for (const i of icons) {
    const txt = (i.textContent ?? '').trim();
    if (CC_ICON_VARIANTS.has(txt)) {
      const btn = i.closest('button, [role="button"]') as HTMLButtonElement | null;
      if (btn) return btn;
    }
  }
  // Strategy 2: aria-label match (multilingual).
  const btns = document.querySelectorAll<HTMLButtonElement>('button[aria-label], [role="button"][aria-label]');
  for (const b of btns) {
    const label = b.getAttribute('aria-label') ?? '';
    if (CC_LABEL_RE.test(label)) return b;
  }
  return null;
}

function isCCActive(btn: HTMLButtonElement): boolean {
  const pressed = btn.getAttribute('aria-pressed');
  if (pressed === 'true') return true;
  const label = btn.getAttribute('aria-label') ?? '';
  // "Tắt phụ đề" / "Turn off captions" => currently ON.
  // (Meet renders the captions container even when CC is off, so we cannot
  // rely on findCaptionRegions() — it gives false positives.)
  if (/turn off|tắt/i.test(label)) return true;
  return false;
}

// Meet's toolbar buttons listen to pointerdown via jsaction; synthetic
// pointer/click events from the isolated content-script world often fail
// to trigger the handler (Closure jsaction may bail on `setPointerCapture`
// failures or check pointer id). Three strategies, fired together:
//   1. native btn.click()  — works for some builds
//   2. full pointer sequence — covers most jsaction handlers
//   3. keyboard shortcut 'C' — Meet's built-in CC toggle, most reliable
function realisticClick(el: HTMLElement) {
  const opts = { bubbles: true, cancelable: true, composed: true, view: window } as const;
  try { (el as HTMLButtonElement).focus?.(); } catch {/**/}
  try { (el as HTMLButtonElement).click?.(); } catch {/**/}
  const pointerInit = {
    ...opts,
    pointerType: 'mouse',
    button: 0,
    pointerId: 1,
    isPrimary: true,
  } as const;
  el.dispatchEvent(new PointerEvent('pointerover', pointerInit));
  el.dispatchEvent(new PointerEvent('pointerenter', pointerInit));
  el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
  el.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerup', pointerInit));
  el.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...opts, button: 0 }));
}

// Press the 'C' key, Meet's default keyboard shortcut for toggling CC.
// Works even when the button click delegation fails because keyboard
// listeners in Meet are simpler (registered on document/body).
function pressCToggleCC() {
  const init: KeyboardEventInit = {
    key: 'c',
    code: 'KeyC',
    keyCode: 67,
    which: 67,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  // Ensure body has focus so the shortcut isn't typed into a text field.
  if (
    document.activeElement &&
    /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
  ) {
    (document.activeElement as HTMLElement).blur();
  }
  const target = document.body ?? document;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  // Also try at document & window for safety.
  document.dispatchEvent(new KeyboardEvent('keydown', init));
  document.dispatchEvent(new KeyboardEvent('keyup', init));
}

async function autoEnableCCIfNeeded() {
  const settings = await getSettings();
  console.log('[Meet Assistant] auto-CC: captionMode =', settings.captionMode);
  if (settings.captionMode !== 'auto') return;
  // Wait ~2.5s before the first click attempt. Meet's toolbar doesn't
  // wire up its jsaction handlers immediately — clicks during the
  // "joining" phase get swallowed silently. After the toolbar is fully
  // mounted, the CC button responds to a single click reliably.
  console.log('[Meet Assistant] auto-CC: waiting 2.5s for Meet UI to settle…');
  await new Promise((r) => setTimeout(r, 2500));
  const deadline = Date.now() + 30_000;
  let attempts = 0;
  let lastBtn: HTMLButtonElement | null = null;
  const tryOnce = (): boolean => {
    attempts++;
    const btn = findCCButton();
    if (!btn) {
      if (attempts === 1 || attempts % 5 === 0)
        console.log(`[Meet Assistant] auto-CC attempt ${attempts}: button not found yet`);
      return false;
    }
    lastBtn = btn;
    if (isCCActive(btn)) {
      console.log(`[Meet Assistant] auto-CC: enabled after ${attempts} attempts`);
      return true;
    }
    // Click in the page's MAIN world via service worker — synthetic events
    // from content-script isolated world don't trigger Meet's jsaction.
    console.log(
      `[Meet Assistant] auto-CC attempt ${attempts}: main-world click (label="${btn.getAttribute('aria-label')}")`,
    );
    chrome.runtime.sendMessage({ type: 'MAIN_WORLD_CLICK_CC' }).catch(() => {});
    return false;
  };
  const loop = () => {
    if (tryOnce()) return;
    if (Date.now() > deadline) {
      console.warn(
        `[Meet Assistant] auto-CC: timeout after ${attempts} attempts. Last button:`,
        lastBtn,
      );
      return;
    }
    setTimeout(loop, 1000);
  };
  loop();
}

// ---------- Debug side panel ----------

let panelHost: HTMLElement | null = null;

function applyPanelMode(mode: PanelMode) {
  if (mode === 'hidden') {
    if (panelHost) panelHost.style.display = 'none';
    return;
  }
  const wasInjected = !!debugRoot;
  ensureDebugPanel();
  renderDebug();
  if (!panelHost) return;
  panelHost.style.display = '';
  if (mode === 'full') {
    panelHost.style.top = '0';
    panelHost.style.height = '100vh';
  } else {
    panelHost.style.top = '72px';
    panelHost.style.height = '';
  }
  const panel = debugRoot?.getElementById('panel') as HTMLElement | null;
  const tab = debugRoot?.getElementById('tab') as HTMLElement | null;
  if (panel) panel.classList.toggle('full', mode === 'full');
  // First time we inject the panel on this page (e.g., user just landed on
  // Meet with mode='full' persisted), start collapsed — only the icon shows.
  // For subsequent applyPanelMode calls (toggling from popup at runtime),
  // open it expanded so the user immediately sees the result of their click.
  if (!wasInjected && mode === 'full') {
    panel?.classList.add('collapsed');
    tab?.classList.add('show');
  } else {
    panel?.classList.remove('collapsed');
    tab?.classList.remove('show');
  }
}

function ensureDebugPanel() {
  if (debugRoot) return;
  const host = document.createElement('div');
  host.id = '__meet_assistant_debug__';
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.top = '72px';
  host.style.right = '0';
  host.style.zIndex = '2147483647';
  // Important: host has no width-clipping; making it pointer-events:none means
  // Meet's UI underneath stays clickable. The .panel inside re-enables events.
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);
  panelHost = host;
  debugRoot = host.attachShadow({ mode: 'open' });
  debugRoot.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
      .panel {
        width: 360px; max-height: 70vh;
        background: #1f1f23; color: #e8e8ea;
        border-radius: 10px 0 0 10px; box-shadow: -4px 0 16px rgba(0,0,0,.35);
        transform: translateX(0); transition: transform .25s ease, width .2s ease;
        display: flex; flex-direction: column; overflow: hidden;
        border: 1px solid #2d2d33; border-right: none;
        pointer-events: auto;  /* re-enable clicks inside the panel */
      }
      .panel.full {
        width: 380px; max-height: none; height: 100vh;
        border-radius: 0;
      }
      .panel.full .body { flex: 1; max-height: none; }
      .panel.collapsed { transform: translateX(100%); }
      .tab {
        position: absolute; top: 80px; right: 0;
        width: 32px; height: 32px;
        border: none; padding: 0;
        background: transparent;
        cursor: pointer; display: none;
        pointer-events: auto;
        opacity: 0.92;
        filter: drop-shadow(-2px 2px 8px rgba(124, 58, 237, 0.4));
        transition: opacity 0.15s, transform 0.15s;
        align-items: center; justify-content: center;
        overflow: hidden;
        border-radius: 8px 0 0 8px;
      }
      .tab.show { display: flex; }
      .tab:hover { opacity: 1; transform: translateX(-2px) scale(1.05); }
      .tab img {
        width: 100%; height: 100%;
        display: block;
        border-radius: 8px 0 0 8px;
        object-fit: cover;
        object-position: left center;
      }
      .head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px; background: #2a2a30; cursor: pointer;
        font-size: 12px; font-weight: 600; user-select: none;
      }
      .head .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#888; margin-right:6px; }
      .head .dot.on { background: #2ecc71; }
      .body { padding: 8px 12px; overflow-y: auto; font-size: 12px; line-height: 1.45; }
      .line { padding: 6px 0; border-bottom: 1px solid #2d2d33; }
      .line:last-child { border-bottom: none; }
      .speaker { font-weight: 600; color: #8ab4ff; margin-right: 6px; }
      .ts { color: #777; font-size: 10px; margin-left: 6px; }
      .empty { color: #888; padding: 16px 4px; text-align: center; }
      .meta { padding: 6px 12px; font-size: 11px; color: #888; background:#1a1a1f; border-top:1px solid #2d2d33; }
    </style>
    <div class="panel" id="panel">
      <div class="head" id="head">
        <span><span class="dot" id="dot"></span>Meet Assistant</span>
        <span id="toggle" title="Thu gọn">⟶</span>
      </div>
      <div class="body" id="body"><div class="empty">Đang chờ caption…</div></div>
      <div class="meta" id="meta">0 dòng</div>
      <div class="meta" id="probe" style="border-top:1px dashed #2d2d33; cursor:pointer;">🔍 Probe DOM</div>
      <pre id="probeOut" style="display:none; max-height:200px; overflow:auto; margin:0; padding:8px 12px; background:#0f0f12; color:#9cf; font-size:10px; white-space:pre-wrap;"></pre>
    </div>
    <button class="tab" id="tab" title="Mở Meet AI Assistant">
      <img src="${chrome.runtime.getURL('icons/icon-128.png')}" alt="Meet AI Assistant" />
    </button>
  `;
  debugBody = debugRoot.getElementById('body') as HTMLElement;
  const panel = debugRoot.getElementById('panel') as HTMLElement;
  const toggle = debugRoot.getElementById('toggle') as HTMLElement;
  const tab = debugRoot.getElementById('tab') as HTMLElement;
  const collapse = () => {
    panel.classList.add('collapsed');
    tab.classList.add('show');
  };
  const expand = () => {
    panel.classList.remove('collapsed');
    tab.classList.remove('show');
  };
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    collapse();
  });
  tab.addEventListener('click', expand);
  const probe = debugRoot.getElementById('probe') as HTMLElement;
  const probeOut = debugRoot.getElementById('probeOut') as HTMLElement;
  probe.addEventListener('click', (e) => {
    e.stopPropagation();
    probeOut.style.display = probeOut.style.display === 'none' ? 'block' : 'none';
    if (probeOut.style.display === 'block') probeOut.textContent = probeDom();
  });
}

function setProbeInfo(s: string) {
  if (!debugRoot) return;
  const meta = debugRoot.getElementById('meta') as HTMLElement | null;
  if (meta) meta.dataset.probe = s;
}

function renderDebug() {
  if (!debugRoot || !debugBody) return;
  const dot = debugRoot.getElementById('dot') as HTMLElement;
  const meta = debugRoot.getElementById('meta') as HTMLElement;
  if (currentMeetingId) dot.classList.add('on');
  else dot.classList.remove('on');
  const probeInfo = meta.dataset.probe ?? '';
  meta.textContent = `${debugByBlock.size} dòng${currentMeetingId ? ` · ${currentMeetingId}` : ''}${probeInfo ? ` · ${probeInfo}` : ''}`;
  if (debugByBlock.size === 0) {
    debugBody.innerHTML = `<div class="empty">${currentMeetingId ? 'Đang chờ caption… (bật CC trong Meet)' : 'Chưa vào meeting'}</div>`;
    return;
  }
  const all = debugOrder.map((id) => debugByBlock.get(id)!).filter(Boolean);
  debugBody.innerHTML = all
    .map((l) => {
      const t = new Date(l.ts);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
      return `<div class="line"><span class="speaker">${escape(l.speaker)}</span><span class="ts">${hh}:${mm}:${ss}</span><div>${escape(l.text)}</div></div>`;
    })
    .join('');
  debugBody.scrollTop = debugBody.scrollHeight;
}

// ---------- Lifecycle ----------

// Detect whether the user has actually JOINED the call (vs still on the
// pre-join lobby with the "Tham gia ngay" / "Join now" button). The leave
// call button (call_end icon) only renders inside the in-call toolbar.
function isInCall(): boolean {
  const icons = document.querySelectorAll('i.google-symbols, i.notranslate');
  for (const i of icons) {
    if ((i.textContent ?? '').trim() === 'call_end') return true;
  }
  return false;
}

// Wait until the user joins the call. Resolves immediately if already in
// call, otherwise watches DOM for the leave-call button to appear.
let joinWaiter: { abort: () => void } | null = null;
function waitForJoin(): Promise<void> {
  joinWaiter?.abort();
  return new Promise<void>((resolve) => {
    if (isInCall()) return resolve();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearInterval(poll);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (isInCall()) finish();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Belt + suspenders: also poll every 1s in case mutations are missed.
    const poll = setInterval(() => {
      if (isInCall()) finish();
    }, 1000);
    joinWaiter = {
      abort: () => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearInterval(poll);
        resolve();
      },
    };
  });
}

async function start() {
  const id = getMeetingId();
  if (!id || id === currentMeetingId) return;
  console.log('[Meet Assistant] URL matches meeting, waiting for user to join…');
  await waitForJoin();
  // URL might have changed while waiting — re-validate.
  const idNow = getMeetingId();
  if (!idNow || idNow === currentMeetingId) return;
  console.log('[Meet Assistant] User joined — starting capture');
  currentMeetingId = idNow;
  renderDebug();
  await send({ type: 'CAPTURE_START', meetingId: idNow, title: getMeetingTitle() });
  autoEnableCCIfNeeded();
  rootObserver?.disconnect();
  rootObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.removedNodes.length) harvestRemovedNodes(m.removedNodes);
    }
    scheduleScan();
  });
  rootObserver.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  if (scanInterval) clearInterval(scanInterval);
  // Safety-net periodic scan: catches mutations that observer batched/missed
  // (Meet sometimes replaces large subtrees in one go). Cost is trivial since
  // dedupe-by-norm short-circuits unchanged blocks.
  scanInterval = window.setInterval(scheduleScan, 1500);
  scheduleScan();
}

async function stop() {
  joinWaiter?.abort();
  joinWaiter = null;
  if (!currentMeetingId) return;
  await send({ type: 'CAPTURE_END', meetingId: currentMeetingId });
  rootObserver?.disconnect();
  rootObserver = null;
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  currentMeetingId = null;
  renderDebug();
}

// SPA navigation: re-check on URL change
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (getMeetingId()) start();
    else stop();
  }
}).observe(document, { subtree: true, childList: true });

// (1) Detect click on Meet's "Rời khỏi cuộc gọi" / "Leave call" button.
// Identified by either aria-label (multilingual: vi/en/...) or the
// `call_end` Material Symbol icon inside. We listen on the document with
// capture so the handler runs before Meet's own (which may dismount the
// button immediately).
const LEAVE_LABEL_RE = /(rời\s*khỏi|leave|kết thúc|ngắt)/i;

function isLeaveButton(el: Element | null): boolean {
  if (!el) return false;
  const btn = el.closest('button, [role="button"]') as HTMLElement | null;
  if (!btn) return false;
  const label = btn.getAttribute('aria-label') ?? '';
  if (LEAVE_LABEL_RE.test(label)) return true;
  // Fallback: look for the Material Symbol icon "call_end".
  const icon = btn.querySelector('i.google-symbols, i.notranslate');
  if (icon && (icon.textContent ?? '').trim() === 'call_end') return true;
  return false;
}

document.addEventListener(
  'click',
  (e) => {
    const target = e.target as Element | null;
    if (isLeaveButton(target)) {
      // Fire-and-forget — page may navigate away in milliseconds.
      void stop();
    }
  },
  true,
);

// (2) Use both `pagehide` and `beforeunload` to maximize the chance the
// CAPTURE_END message is delivered when the user closes the tab/browser.
// `pagehide` is more reliable than `beforeunload` on mobile and BFCache.
const onUnload = () => {
  void stop();
};
window.addEventListener('beforeunload', onUnload);
window.addEventListener('pagehide', onUnload);

// Apply persisted panel mode + react to popup toggling.
// Hidden by default — panel only injects when user explicitly toggles in popup.
getPanelMode().then(applyPanelMode);
watchPanelMode(applyPanelMode);

// React to settings changes (especially captionMode flips). When user
// switches to "auto" mid-meeting, immediately try to enable CC instead
// of waiting for the next page-load.
let lastCaptionMode: string | null = null;
watchSettings((s) => {
  console.log('[Meet Assistant] settings changed: captionMode =', s.captionMode);
  if (s.captionMode === 'auto' && s.captionMode !== lastCaptionMode && currentMeetingId) {
    autoEnableCCIfNeeded();
  }
  lastCaptionMode = s.captionMode;
});
getSettings().then((s) => {
  lastCaptionMode = s.captionMode;
  console.log('[Meet Assistant] initial settings: captionMode =', s.captionMode);
});

// Hide Meet's native captions overlay while still letting its DOM update so
// our observer can read it. We move the container offscreen instead of using
// display:none — display:none would remove it from the render tree and Meet
// might stop emitting caption updates.
const HIDE_CC_STYLE_ID = '__meet_assistant_hide_cc__';
function applyHideMeetCC(hide: boolean) {
  const existing = document.getElementById(HIDE_CC_STYLE_ID);
  if (!hide) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const style = document.createElement('style');
  style.id = HIDE_CC_STYLE_ID;
  // We try several selectors: the captions panel (.a4cQT), the inner display
  // container (.iOzk7 / [jsname=dsyhDe]) and the role=region itself.
  // display:none keeps the DOM tree intact so MutationObserver still fires;
  // it only removes the elements from the visual render tree.
  style.textContent = `
    .a4cQT,
    [jsname="dsyhDe"],
    .iOzk7,
    [role="region"][aria-label*="phụ đề" i],
    [role="region"][aria-label*="caption" i],
    [role="region"][aria-label*="subtitle" i] {
      display: none !important;
    }
  `;
  document.documentElement.appendChild(style);
}
getHideMeetCC().then(applyHideMeetCC);
watchHideMeetCC(applyHideMeetCC);

if (getMeetingId()) {
  // wait a tick for Meet UI to mount
  setTimeout(start, 1500);
}
