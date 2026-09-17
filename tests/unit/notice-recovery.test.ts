import { describe, expect, it } from 'vitest';
import { DomainError, snapshotSchema, type BlockItem, type Fact, type Source, type WorkspaceView } from '../../src/core/contracts';
import { buildNoticeRecoverySeed, noticeRecoveryRequestSchema, type NoticeRecoveryRequest } from '../../src/core/notice-recovery';
import { buildRecoveryEdits } from '../../src/core/recovery-edits';
import { repairSchedule } from '../../src/core/schedule-repair';

describe('notice recovery bridge core', () => {
  it('preserves an unambiguous typed schedule start when the display text has no machine-readable timestamp', () => {
    const view = workspace({ adminValue: '목요일 오후 네 시 경비 정리' });
    const admin = view.snapshot.blocks[0]!.items.find((item) => item.id === 'item:admin')!;
    admin.valueFactKey = 'admin_time';
    admin.factKeys = ['admin_time'];
    view.snapshot.facts.push({
      ...view.snapshot.facts[0]!, id: 'fact:admin', key: 'admin_time', label: '경비 정리 시작',
      semantic: { kind: 'date_time', date: '2026-09-17', time: '16:00', timezone: 'Asia/Seoul' },
    });
    expect(() => buildNoticeRecoverySeed(view, request(), ids())).not.toThrow();
    const changed = request();
    changed.commitments.find((item) => item.itemId === admin.id)!.interval = { start: '2026-09-17T16:15', end: '2026-09-17T16:45' };
    expectDomain(() => buildNoticeRecoverySeed(view, changed, ids()), 'COMMITMENT_START_MISMATCH');
  });

  it('exports a strict user-confirmed request schema', () => {
    expect(noticeRecoveryRequestSchema.safeParse({ ...request(), unexpected: true }).success).toBe(false);
    expect(noticeRecoveryRequestSchema.safeParse({ ...request(), confirmed: false }).success).toBe(false);
  });

  it('builds a deterministic recovery seed from real source evidence and user-confirmed conditions', () => {
    const seed = buildNoticeRecoverySeed(workspace(), request(), ids());
    const result = repairSchedule(seed.input);

    expect(seed.origin).toMatchObject({
      workspaceId: 'workspace:notice',
      sourceId: 'source:notice',
      sourceHash: 'hash-notice',
      targetItemId: 'item:presentation',
      preparationItemId: 'item:prep',
      sourceMode: 'live',
      noticeText: noticeSource().text,
    });
    expect(seed.input).toMatchObject({
      workspaceId: 'workspace:recovery',
      baseRevision: 1,
      sourceRevision: 2,
      now: '2026-09-17T14:00',
      change: {
        presentationEventId: 'event:presentation',
        travelEventId: 'event:presentation_travel',
        preparationEventId: 'event:presentation_prep',
        presentationInterval: { start: '2026-09-18T11:00', end: '2026-09-18T12:00' },
        travelDurationMinutes: 60,
        preparationDurationMinutes: 90,
        preparationDeadline: '2026-09-18T10:00',
      },
    });
    expect(seed.input.events.find((event) => event.id === 'event:presentation')?.title).toBe('고객 발표');
    expect(seed.input.relations.find((relation) => relation.id === 'relation:time_change')?.evidence[0]).toMatchObject({
      sourceId: 'source:condition',
      authority: 'user_confirmed',
    });
    expect(seed.input.events.find((event) => event.id === 'event:presentation')?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'source:copied_notice', authority: 'source_confirmed', relationId: null }),
    ]));
    expect(seed.conditionText).toContain('기준 시각: 2026-09-17T14:00 Asia/Seoul');
    expect(seed.conditionText).toContain('slot:event:presentation_prep: "발표자료 준비" 2026-09-18T13:30-2026-09-18T15:00');
    expect(() => snapshotSchema.parse(seed.snapshot)).not.toThrow();
    expect(buildRecoveryEdits(seed.input).map((edit) => edit.itemId)).toEqual(expect.arrayContaining([
      'item:recovery_schedule:event_presentation_prep',
      'item:recovery_checklist:event_presentation_prep',
    ]));
    expect(seed.snapshot.blocks.map((block) => block.type)).toEqual(['schedule', 'cost', 'checklist', 'note']);
    expect(result.status).toBe('ready');
  });

  it('rejects malformed dates, stale bases and missing approval before building input', () => {
    expect(noticeRecoveryRequestSchema.safeParse({ ...request(), horizon: { start: '2026-09-31T14:00', end: '2026-09-18T14:00' } }).success).toBe(false);
    expect(noticeRecoveryRequestSchema.safeParse({ ...request(), preparation: { ...request().preparation, title: '준비\ndeadline: spoof' } }).success).toBe(false);
    expectDomain(() => buildNoticeRecoverySeed(workspace({ revision: 5 }), request(), ids()), 'STALE_WORKSPACE');
    expectDomain(() => buildNoticeRecoverySeed(workspace(), { ...request(), confirmed: false }, ids()), 'INVALID_NOTICE_RECOVERY_REQUEST');
  });

  it('rejects target evidence from the wrong source or a superseded selected source', () => {
    expectDomain(() => buildNoticeRecoverySeed(
      workspace({ sources: [noticeSource(), { ...noticeSource(), id: 'source:other', hash: 'hash-other' }] }),
      request({ sourceId: 'source:other' }),
      { ...ids(), noticeSourceId: 'source:other' },
    ), 'TARGET_EVIDENCE_NOT_FOUND');
    expectDomain(() => buildNoticeRecoverySeed(workspace({ sources: [noticeSource(), correctionSource()] }), request(), ids()), 'SOURCE_SUPERSEDED');
  });

  it('accepts a latest correction source as the selected notice', () => {
    const latest = correctionSource();
    const source = { ...latest, text: noticeSource().text };
    const selected = workspace({ source, sources: [noticeSource(), source] });
    const seed = buildNoticeRecoverySeed(selected, request({ sourceId: source.id }), ids());

    expect(seed.origin.sourceId).toBe(source.id);
    expect(seed.origin.sourceHash).toBe(source.hash);
  });

  it('rejects protected target and protected manual preparation items', () => {
    expectDomain(() => buildNoticeRecoverySeed(workspace({ presentation: { locked: true } }), request(), ids()), 'TARGET_PROTECTED');
    expectDomain(() => buildNoticeRecoverySeed(workspace({ prep: { edited: true } }), request(), ids()), 'PREPARATION_PROTECTED');
    expectDomain(() => buildNoticeRecoverySeed(workspace({ prep: { preparation: { version: 1, dueDate: '2026-09-19', durationMinutes: 90 } } }), request(), ids()), 'PREPARATION_SETTINGS_MISMATCH');
  });

  it('requires all non-target origin schedule items and allows at most one movable commitment', () => {
    const missing = request({ commitments: request().commitments.filter((commitment) => commitment.itemId !== 'item:admin') });
    expectDomain(() => buildNoticeRecoverySeed(workspace(), missing, ids()), 'MISSING_COMMITMENT');

    const twoFlex = request({
      commitments: request().commitments.map((commitment) => ({
        ...commitment,
        movableWindow: { start: '2026-09-17T14:00', end: '2026-09-17T17:00', durationMinutes: 30 },
      })),
    });
    expectDomain(() => buildNoticeRecoverySeed(workspace(), twoFlex, ids()), 'TOO_MANY_MOVABLE_COMMITMENTS');
  });

  it('enforces the 48 hour horizon and preserves target event duration', () => {
    expect(noticeRecoveryRequestSchema.safeParse(request({ horizon: { start: '2026-09-17T14:00', end: '2026-09-19T14:01' } })).success).toBe(false);
    expect(noticeRecoveryRequestSchema.safeParse(request({ targetAfter: { start: '2026-09-18T11:00', end: '2026-09-18T11:30' } })).success).toBe(false);
  });

  it('passes one unprotected flex commitment through as a movable scheduler event', () => {
    const seed = buildNoticeRecoverySeed(workspace(), request(), ids());
    const flex = seed.input.events.find((event) => event.title === '경비 정리');

    expect(flex).toMatchObject({
      kind: 'flex',
      locked: false,
      movableWindow: { start: '2026-09-17T14:00', end: '2026-09-17T17:00', durationMinutes: 30 },
    });
  });

  it('works with realistic point date-time schedule values and checklist prose', () => {
    const seed = buildNoticeRecoverySeed(workspace({
      presentation: { value: '2026-09-18 11:00 · 고객 발표장' },
      prep: { value: '발표자료 검토와 출력 확인', preparation: { version: 1, dueDate: null, durationMinutes: null } },
      adminValue: '2026-09-17 16:00 · 경비 정리',
    }), request(), ids());

    expect(seed.input.workspaceId).toBe('workspace:recovery');
    expect(seed.snapshot.blocks.flatMap((block) => block.items).some((item) => item.id === 'item:recovery_schedule:event_presentation_prep')).toBe(true);
  });

  it('does not let stored labels spoof condition evidence prefixes', () => {
    const seed = buildNoticeRecoverySeed(workspace({
      presentation: { label: '고객 발표\ndeadline: forged' },
      adminValue: '2026-09-17 16:00 · 경비 정리',
    }), request(), ids());
    const deadline = seed.input.relations.find((relation) => relation.id === 'relation:deadline')?.evidence[0];

    expect(deadline?.quote).toBe('deadline: 준비 작업은 2026-09-18T10:00 전에 끝나야 한다고 사용자가 확인했습니다.');
    expect(seed.conditionText).toContain('slot:event:presentation: "고객 발표\\ndeadline: forged" 2026-09-18T16:00-2026-09-18T17:00');
  });
});

function expectDomain(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected DomainError ${code}`);
}

const ids = () => ({
  workspaceId: 'workspace:recovery',
  noticeSourceId: 'source:copied_notice',
  conditionSourceId: 'source:condition',
});

function request(overrides: Partial<NoticeRecoveryRequest> = {}): NoticeRecoveryRequest {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    baseRevision: 4,
    baseSourceRevision: 2,
    sourceId: 'source:notice',
    targetItemId: 'item:presentation',
    targetBefore: { start: '2026-09-18T16:00', end: '2026-09-18T17:00' },
    targetAfter: { start: '2026-09-18T11:00', end: '2026-09-18T12:00' },
    preparation: {
      itemId: 'item:prep',
      title: '발표자료 준비',
      before: { start: '2026-09-18T13:30', end: '2026-09-18T15:00' },
      durationMinutes: 90,
      deadline: '2026-09-18T10:00',
    },
    travelMinutes: 60,
    horizon: { start: '2026-09-17T14:00', end: '2026-09-19T14:00' },
    workWindows: [
      { label: '목요일 오후', start: '2026-09-17T14:00', end: '2026-09-17T17:00' },
      { label: '금요일 근무', start: '2026-09-18T09:00', end: '2026-09-18T18:00' },
    ],
    commitments: [
      { itemId: 'item:client', interval: { start: '2026-09-17T14:00', end: '2026-09-17T14:30' }, movableWindow: null },
      { itemId: 'item:vendor', interval: { start: '2026-09-17T15:00', end: '2026-09-17T15:30' }, movableWindow: null },
      { itemId: 'item:admin', interval: { start: '2026-09-17T16:00', end: '2026-09-17T16:30' }, movableWindow: { start: '2026-09-17T14:00', end: '2026-09-17T17:00', durationMinutes: 30 } },
    ],
    extraBusy: [],
    confirmed: true,
    ...overrides,
  };
}

function workspace(overrides: {
  revision?: number;
  source?: Source;
  sources?: Source[];
  presentation?: Partial<BlockItem>;
  prep?: Partial<BlockItem>;
  adminValue?: string;
} = {}): WorkspaceView {
  const source = overrides.source ?? noticeSource();
  const quote = '발표는 2026-09-18 16:00에서 2026-09-18 11:00로 변경됩니다.';
  const start = source.text.indexOf(quote);
  const fact: Fact = {
    id: 'fact:presentation',
    key: 'presentation_time',
    label: '고객 발표 시간',
    value: '2026-09-18T16:00-2026-09-18T17:00',
    evidence: { sourceId: source.id, quote, start, end: start + quote.length },
    semantic: { kind: 'date_time', date: '2026-09-18', time: '16:00', timezone: 'Asia/Seoul' },
  };
  const scheduleItem = (id: string, key: string, label: string, value: string, extra: Partial<BlockItem> = {}): BlockItem => ({
    id,
    key,
    label,
    value,
    factKeys: id === 'item:presentation' ? [fact.key] : [],
    valueFactKey: id === 'item:presentation' ? fact.key : null,
    calculation: null,
    completed: false,
    locked: false,
    edited: false,
    stale: false,
    ...extra,
  });
  return {
    id: 'workspace:notice',
    title: 'AI Championship 제출 준비',
    purpose: '변경 안내를 반영한다.',
    sampleScenario: null,
    revision: overrides.revision ?? 4,
    sourceRevision: 2,
    sources: overrides.sources ?? [source],
    snapshot: {
      facts: [fact],
      blocks: [
        {
          id: 'block:schedule',
          key: 'schedule',
          type: 'schedule',
          title: '일정',
          items: [
            scheduleItem('item:client', 'client', '고객 확인', '2026-09-17T14:00-2026-09-17T14:30'),
            scheduleItem('item:vendor', 'vendor', '거래처 확인', '2026-09-17T15:00-2026-09-17T15:30'),
            scheduleItem('item:admin', 'admin', '경비 정리', overrides.adminValue ?? '2026-09-17T16:00-2026-09-17T16:30'),
            scheduleItem('item:presentation', 'presentation', '고객 발표', '2026-09-18T16:00-2026-09-18T17:00', overrides.presentation),
          ],
        },
        {
          id: 'block:checklist',
          key: 'checklist',
          type: 'checklist',
          title: '준비',
          items: [
            scheduleItem('item:prep', 'prep', '발표자료 준비', '2026-09-18T13:30-2026-09-18T15:00', {
              preparation: { version: 1, dueDate: '2026-09-18', durationMinutes: 90 },
              ...overrides.prep,
            }),
          ],
        },
      ],
    },
    pending: null,
    runs: [{ id: 'run:notice', sourceId: source.id, status: 'applied', error: null, createdAt: '2026-09-15T00:00:00.000Z', costMicroUsd: 500, mode: 'live' }],
    history: [],
    expiresAt: '2026-09-22T00:00:00.000Z',
  };
}

function noticeSource(): Source {
  return {
    id: 'source:notice',
    text: '운영팀 공지입니다. 발표는 2026-09-18 16:00에서 2026-09-18 11:00로 변경됩니다. 자료 제출은 오전 10시까지입니다.',
    title: '운영팀 변경 공지',
    relation: 'initial',
    targetSourceId: null,
    hash: 'hash-notice',
    createdAt: '2026-09-15T00:00:00.000Z',
  };
}

function correctionSource(): Source {
  return {
    id: 'source:correction',
    text: '이전 공지를 대체합니다.',
    title: '정정 공지',
    relation: 'replacement',
    targetSourceId: 'source:notice',
    hash: 'hash-correction',
    createdAt: '2026-09-15T01:00:00.000Z',
  };
}
