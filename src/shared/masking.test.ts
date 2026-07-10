import { describe, expect, it } from 'vitest';
import { DEFAULT_MASKING } from './constants';
import { createMaskContext, maskText, unmask, unmaskResult } from './masking';
import type { MaskingPreferences, TranscriptRecord } from './types';

function transcript(lines: { speaker: string; text: string }[]): TranscriptRecord {
  return {
    id: 'm1',
    createdAt: 0,
    lines: lines.map((l, i) => ({ ...l, ts: i, hash: `h${i}`, source: 'text' as const })),
  };
}

const prefs = (over: Partial<MaskingPreferences> = {}): MaskingPreferences => ({
  ...DEFAULT_MASKING,
  enabled: true,
  ...over,
});

describe('masking', () => {
  it('masks speaker names and restores them (round-trip)', () => {
    const t = transcript([
      { speaker: 'Nguyễn Văn A', text: 'Chào mọi người' },
      { speaker: 'Trần B', text: 'Nguyễn Văn A trình bày trước nhé' },
    ]);
    const ctx = createMaskContext(t, prefs());
    const masked = maskText('Nguyễn Văn A và Trần B họp', ctx);
    expect(masked).not.toContain('Nguyễn Văn A');
    expect(masked).not.toContain('Trần B');
    expect(unmask(masked, ctx)).toBe('Nguyễn Văn A và Trần B họp');
  });

  it('replaces longer names before shorter overlapping ones', () => {
    const t = transcript([{ speaker: 'Nguyễn Văn An', text: '' }]);
    const ctx = createMaskContext(t, prefs());
    const masked = maskText('Nguyễn Văn An phát biểu', ctx);
    expect(masked).toMatch(/^\[\[PER1\]\] phát biểu$/);
  });

  it('masks dictionary terms', () => {
    const ctx = createMaskContext(null, prefs({ dictionary: 'Dự án Alpha\nFPT Software' }));
    const masked = maskText('Dự án Alpha do FPT Software thực hiện', ctx);
    expect(masked).not.toContain('Alpha');
    expect(masked).not.toContain('FPT');
    expect(unmask(masked, ctx)).toBe('Dự án Alpha do FPT Software thực hiện');
  });

  it('masks emails and phones', () => {
    const ctx = createMaskContext(null, prefs());
    const masked = maskText('Liên hệ a.nguyen@fpt.com hoặc 0901234567', ctx);
    expect(masked).not.toContain('@fpt.com');
    expect(masked).not.toContain('0901234567');
    expect(unmask(masked, ctx)).toContain('a.nguyen@fpt.com');
  });

  it('unmask tolerates whitespace/case drift in tokens', () => {
    const t = transcript([{ speaker: 'Nguyễn Văn A', text: '' }]);
    const ctx = createMaskContext(t, prefs());
    maskText('Nguyễn Văn A', ctx);
    expect(unmask('Theo [[ per 1 ]] thì ok', ctx)).toBe('Theo Nguyễn Văn A thì ok');
  });

  it('unmask handles bracket-stripped / lowercased mangling from the model', () => {
    const t = transcript([{ speaker: 'Nguyễn Văn A', text: '' }]);
    const ctx = createMaskContext(t, prefs());
    maskText('Nguyễn Văn A', ctx);
    expect(unmask('per1 báo cáo, [PER1] và PER-1 cũng vậy', ctx)).toBe(
      'Nguyễn Văn A báo cáo, Nguyễn Văn A và Nguyễn Văn A cũng vậy',
    );
  });

  it('PER1 does not corrupt PER10 (no greedy overlap)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ speaker: `Người ${i}`, text: '' }));
    const ctx = createMaskContext(transcript(lines), prefs());
    // Force PER1..PER10 to exist by masking all speaker names.
    maskText(lines.map((l) => l.speaker).join(' '), ctx);
    const tenth = ctx.byOriginal.get('người 9'); // 10th registered → PER10
    expect(tenth).toBe('[[PER10]]');
    expect(unmask('Gặp [[PER10]] và [[PER1]]', ctx)).toBe('Gặp Người 9 và Người 0');
  });

  it('is a no-op when disabled', () => {
    const ctx = createMaskContext(null, { ...DEFAULT_MASKING, enabled: false });
    expect(maskText('Nguyễn Văn A', ctx)).toBe('Nguyễn Văn A');
  });

  it('unmaskResult restores all fields', () => {
    const t = transcript([{ speaker: 'Nguyễn Văn A', text: '' }]);
    const ctx = createMaskContext(t, prefs({ dictionary: 'Dự án Alpha' }));
    maskText('Nguyễn Văn A Dự án Alpha', ctx);
    const restored = unmaskResult(
      {
        summary: '[[PER1]] báo cáo [[TRM1]]',
        actionItems: [{ text: '[[PER1]] làm việc', assignee: '[[PER1]]' }],
        decisions: ['Chốt [[TRM1]]'],
        pendingIssues: [],
        keywords: ['[[TRM1]]'],
        participants: ['[[PER1]]'],
        draftEmail: { subject: '[[TRM1]]', body: 'Gửi [[PER1]]' },
      },
      ctx,
    );
    expect(restored.summary).toBe('Nguyễn Văn A báo cáo Dự án Alpha');
    expect(restored.actionItems[0].assignee).toBe('Nguyễn Văn A');
    expect(restored.draftEmail?.body).toBe('Gửi Nguyễn Văn A');
    expect(restored.keywords?.[0]).toBe('Dự án Alpha');
  });
});
