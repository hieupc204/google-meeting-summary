import {
  DB_NAME,
  DB_VERSION,
  STORE_AUDIOS,
  STORE_MEETINGS,
  STORE_TRANSCRIPTS,
} from './constants';
import type {
  MeetingRecord,
  TranscriptEntry,
  TranscriptLine,
  TranscriptRecord,
} from './types';

function isLine(e: TranscriptEntry): e is TranscriptLine {
  return (e as TranscriptLine).hash !== undefined;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        const transcripts = db.createObjectStore(STORE_TRANSCRIPTS, { keyPath: 'id' });
        transcripts.createIndex('createdAt', 'createdAt');

        const meetings = db.createObjectStore(STORE_MEETINGS, { keyPath: 'id' });
        meetings.createIndex('createdAt', 'createdAt');
        meetings.createIndex('summaryStatus', 'summaryStatus');
      }
      if (oldVersion < 2) {
        db.createObjectStore(STORE_AUDIOS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
  return dbPromise;
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result: T;
    Promise.resolve(fn(store))
      .then((r) => {
        if (r instanceof IDBRequest) {
          r.onsuccess = () => {
            result = r.result as T;
          };
          r.onerror = () => reject(r.error);
        } else {
          result = r;
        }
      })
      .catch(reject);
    tx.oncomplete = () => resolve(result!);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------- Meetings ----------

export async function saveMeeting(meeting: MeetingRecord): Promise<void> {
  await withStore(STORE_MEETINGS, 'readwrite', (s) => s.put(meeting));
}

export async function getMeeting(id: string): Promise<MeetingRecord | undefined> {
  return withStore(STORE_MEETINGS, 'readonly', (s) => s.get(id));
}

export async function deleteMeeting(id: string): Promise<void> {
  await Promise.all([
    withStore(STORE_MEETINGS, 'readwrite', (s) => s.delete(id)),
    withStore(STORE_TRANSCRIPTS, 'readwrite', (s) => s.delete(id)),
    withStore(STORE_TRANSCRIPTS, 'readwrite', (s) => s.delete(`${id}:audio`)),
    withStore(STORE_TRANSCRIPTS, 'readwrite', (s) => s.delete(`${id}:merged`)),
    withStore(STORE_AUDIOS, 'readwrite', (s) => s.delete(id)),
  ]);
}

export async function listRecentMeetings(limit = 50): Promise<MeetingRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MEETINGS, 'readonly');
    const idx = tx.objectStore(STORE_MEETINGS).index('createdAt');
    const out: MeetingRecord[] = [];
    const cursorReq = idx.openCursor(null, 'prev');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as MeetingRecord);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// ---------- Transcripts ----------

export async function saveTranscript(record: TranscriptRecord): Promise<void> {
  await withStore(STORE_TRANSCRIPTS, 'readwrite', (s) => s.put(record));
}

export async function getTranscript(id: string): Promise<TranscriptRecord | undefined> {
  return withStore(STORE_TRANSCRIPTS, 'readonly', (s) => s.get(id));
}

export async function appendTranscriptEntries(
  id: string,
  entries: TranscriptEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    const store = tx.objectStore(STORE_TRANSCRIPTS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = (getReq.result as TranscriptRecord | undefined) ?? {
        id,
        lines: [],
        createdAt: Date.now(),
      };
      existing.lines.push(...entries);
      store.put(existing);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Upsert a caption line by blockId: replace-in-place if a line with the same
// blockId already exists, else append. Preserves the original `ts` from the
// first sighting so timestamps reflect when the speaker started talking.
export async function upsertTranscriptLine(
  id: string,
  line: TranscriptLine,
): Promise<void> {
  if (!line.blockId) {
    await appendTranscriptEntries(id, [line]);
    return;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    const store = tx.objectStore(STORE_TRANSCRIPTS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing: TranscriptRecord = (getReq.result as TranscriptRecord | undefined) ?? {
        id,
        lines: [],
        createdAt: Date.now(),
      };
      const idx = existing.lines.findIndex(
        (e) => isLine(e) && e.blockId === line.blockId,
      );
      if (idx >= 0) {
        const prev = existing.lines[idx] as TranscriptLine;
        existing.lines[idx] = { ...line, ts: prev.ts };
      } else {
        existing.lines.push(line);
      }
      store.put(existing);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Audio blobs ----------

export async function saveAudioBlob(id: string, blob: Blob, mimeType: string): Promise<void> {
  await withStore(STORE_AUDIOS, 'readwrite', (s) =>
    s.put({ id, blob, mimeType, savedAt: Date.now() }),
  );
}

export async function getAudioBlob(
  id: string,
): Promise<{ id: string; blob: Blob; mimeType: string } | undefined> {
  return withStore(STORE_AUDIOS, 'readonly', (s) => s.get(id));
}

export async function deleteAudioBlob(id: string): Promise<void> {
  await withStore(STORE_AUDIOS, 'readwrite', (s) => s.delete(id));
}

export async function deleteTranscriptsBefore(beforeMs: number): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
    const idx = tx.objectStore(STORE_TRANSCRIPTS).index('createdAt');
    const range = IDBKeyRange.upperBound(beforeMs);
    let count = 0;
    const cursorReq = idx.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        count++;
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
  });
}
