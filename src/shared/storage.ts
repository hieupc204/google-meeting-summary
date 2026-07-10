import { DEFAULT_MASKING, DEFAULT_SETTINGS } from './constants';
import type { UserSettings } from './types';

const SETTINGS_KEY = 'settings';
const RECENT_IDS_KEY = 'recentMeetingIds';
const PANEL_MODE_KEY = 'panelMode';
const HIDE_MEET_CC_KEY = 'hideMeetCC';

export type PanelMode = 'hidden' | 'compact' | 'full';

export async function getPanelMode(): Promise<PanelMode> {
  const r = await chrome.storage.local.get(PANEL_MODE_KEY);
  return (r[PANEL_MODE_KEY] as PanelMode | undefined) ?? 'hidden';
}

export async function setPanelMode(mode: PanelMode): Promise<void> {
  await chrome.storage.local.set({ [PANEL_MODE_KEY]: mode });
}

export async function getHideMeetCC(): Promise<boolean> {
  const r = await chrome.storage.local.get(HIDE_MEET_CC_KEY);
  return Boolean(r[HIDE_MEET_CC_KEY]);
}

export async function setHideMeetCC(v: boolean): Promise<void> {
  await chrome.storage.local.set({ [HIDE_MEET_CC_KEY]: v });
}

export function watchHideMeetCC(cb: (v: boolean) => void): () => void {
  const handler = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
    if (area === 'local' && changes[HIDE_MEET_CC_KEY]) {
      cb(Boolean(changes[HIDE_MEET_CC_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export function watchPanelMode(cb: (m: PanelMode) => void): () => void {
  const handler = (changes: { [k: string]: chrome.storage.StorageChange }, area: string) => {
    if (area === 'local' && changes[PANEL_MODE_KEY]) {
      cb((changes[PANEL_MODE_KEY].newValue as PanelMode | undefined) ?? 'hidden');
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export async function getSettings(): Promise<UserSettings> {
  const res = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = res[SETTINGS_KEY] as Partial<UserSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored?.ai ?? {}) },
    summary: { ...DEFAULT_SETTINGS.summary, ...(stored?.summary ?? {}) },
    masking: { ...DEFAULT_MASKING, ...(stored?.masking ?? {}) },
  };
}

export async function setSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await getSettings();
  const next: UserSettings = {
    ...current,
    ...patch,
    ai: { ...current.ai, ...(patch.ai ?? {}) },
    summary: { ...current.summary, ...(patch.summary ?? {}) },
    masking: { ...DEFAULT_MASKING, ...current.masking, ...(patch.masking ?? {}) },
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getRecentMeetingIds(): Promise<string[]> {
  const res = await chrome.storage.local.get(RECENT_IDS_KEY);
  return (res[RECENT_IDS_KEY] as string[] | undefined) ?? [];
}

export async function pushRecentMeetingId(id: string, max = 100): Promise<void> {
  const ids = await getRecentMeetingIds();
  const next = [id, ...ids.filter((x) => x !== id)].slice(0, max);
  await chrome.storage.local.set({ [RECENT_IDS_KEY]: next });
}

export function watchSettings(cb: (s: UserSettings) => void): () => void {
  const handler = async (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      cb(await getSettings());
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
