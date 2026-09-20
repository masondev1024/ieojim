import type { z } from 'zod';
import { recoveryInputSchema, type RecoveryResult } from '../../core/scheduling-contracts';
import { bindRecoverySources } from '../../core/recovery-lineage';
import { repairSchedule } from '../../core/schedule-repair';
import { buildRecoveryScenario, recoveryItemId } from '../../core/schedule-recovery-sample';
import { applyRecoverySchema, previewRecoverySchema, type RecoveryActionView, type RecoveryView } from '../../core/recovery-api-contracts';
import { LIMITS, type WorkspaceView } from '../../core/contracts';
import { buildRecoveryEdits, recoverySlotText } from '../../core/recovery-edits';
import { corePort } from '../core-port';
import { WorkspaceStore } from '../db';
import { ApiException } from '../errors';
import { jsonHash, randomId, sha256Hex } from '../crypto';
import { nowIso, type AppBindings, type OwnerSession } from '../http';
import { assertOriginStillCurrent, hasRecoveryOrigin, readOriginState, staleOriginResult } from './origin';
import { readCalendarVerifications } from './verification';

type Profile = {
  workspace_id: string; condition_revision: number; base_revision: number; base_source_revision: number;
  input_json: string; proposal_id: string; applied_revision: number | null;
};

export { recoverySlotText } from '../../core/recovery-edits';

export class RecoveryStore {
  constructor(readonly env: AppBindings) {}

  async create(owner: OwnerSession, rawInput: unknown, requestId: string): Promise<RecoveryView> {
    const input = recoveryInputSchema.parse(rawInput);
    const result = repairSchedule(input);
    if (result.status === 'invalid_input' || result.status === 'unsupported') throw invalid(result.message);
    if (![input.change.presentationEventId, input.change.travelEventId, input.change.preparationEventId].every((id) => input.events.some((event) => event.id === id))) {
      throw invalid('작업 공간을 만들려면 발표, 이동, 준비 일정을 먼저 확인해 주세요.');
    }
    input.events = input.events.map((event, index) => ({ ...event, itemId: recoveryItemId(event, index) }));
    recoveryInputSchema.parse(input);
    if (new Set(input.events.map((event) => event.itemId)).size !== input.events.length) throw invalid('일정 식별자가 겹칩니다.');
    const scenario = buildRecoveryScenario(input);
    const workspace = await new WorkspaceStore(this.env).createSample(owner.id, null, scenario, corePort, owner, {
      requestId, inputJson: JSON.stringify(input), proposalId: randomId('repair'),
    });
    return this.read(owner.id, workspace.id);
  }

  async read(ownerId: string, workspaceId: string): Promise<RecoveryView> {
    const workspace = await new WorkspaceStore(this.env).getWorkspace(ownerId, workspaceId);
    const profile = await this.profile(workspaceId);
    const originState = await readOriginState(this.env.DB, ownerId, workspaceId);
    const input = recoveryInputSchema.parse(JSON.parse(profile.input_json));
    const stale = profile.base_source_revision !== workspace.sourceRevision ||
      (workspace.revision !== profile.base_revision && workspace.revision !== profile.applied_revision);
    const result: RecoveryResult = !originState.current ? staleOriginResult() :
      stale ? { status: 'missing_information', code: 'stale_workspace', message: '계획이나 원문이 바뀌었습니다. 이전 일정 조정안은 다시 사용할 수 없습니다.', blockers: [] } : repairSchedule(input);
    const actions = await this.env.DB.prepare('SELECT id, kind, status, message, created_at AS createdAt, base_revision AS baseRevision, source_revision AS sourceRevision, condition_revision AS conditionRevision, progress_json, payload_json FROM recovery_actions WHERE workspace_id = ? AND owner_id = ? ORDER BY created_at DESC, id DESC LIMIT 25')
      .bind(workspaceId, ownerId).all<RecoveryActionView & { progress_json: string; payload_json: string }>();
    const verifications = await readCalendarVerifications(this.env.DB, ownerId, workspaceId);
    return {
      workspaceId, revision: workspace.revision, sourceRevision: workspace.sourceRevision,
      conditionRevision: profile.condition_revision, input, result, proposalId: profile.proposal_id,
      applied: originState.current && profile.applied_revision === workspace.revision && profile.base_source_revision === workspace.sourceRevision,
      actions: actions.results.map(({ progress_json, payload_json, ...action }) => {
        if (action.kind !== 'calendar') return action;
        const progress = JSON.parse(progress_json) as { completed?: Record<string, unknown> };
        const payload = JSON.parse(payload_json) as { events?: unknown[] };
        return { ...action, verifiedEvents: Object.keys(progress.completed ?? {}).length, totalEvents: payload.events?.length ?? 0,
          ...(verifications.has(action.id) ? { verification: verifications.get(action.id) } : {}) };
      }),
      ...(originState.origin ? { origin: originState.origin } : {}),
    };
  }

  async preview(ownerId: string, workspaceId: string, command: z.infer<typeof previewRecoverySchema>): Promise<RecoveryView> {
    const hash = await jsonHash({ kind: 'recovery_preview', workspaceId, command });
    const replay = await this.replay(ownerId, workspaceId, command.requestId, hash);
    if (replay) return replay;
    if (await hasRecoveryOrigin(this.env.DB, ownerId, workspaceId)) {
      throw new ApiException('NOTICE_CONDITIONS_LOCKED', '안내문에서 만든 일정 조정 조건은 읽기 전용입니다. 조건을 바꾸려면 기준 작업 공간에서 새 일정 조정안을 만들어 주세요.', 409);
    }
    const workspace = await new WorkspaceStore(this.env).getWorkspace(ownerId, workspaceId);
    const previous = await this.profile(workspaceId);
    this.assertBase(workspace, previous, command.baseRevision, command.conditionRevision);
    const before = recoveryInputSchema.parse(JSON.parse(previous.input_json));
    const oldResult = repairSchedule(before);
    const baseline = previous.applied_revision === workspace.revision && oldResult.status === 'ready' ? oldResult.after : before.events;
    let input = recoveryInputSchema.parse({ ...command.input, workspaceId, baseRevision: workspace.revision, sourceRevision: workspace.sourceRevision + 1 });
    // Calendar positions already saved in this workspace are authoritative;
    // the client may edit constraints but cannot substitute another baseline.
    for (const original of baseline) {
      const event = input.events.find((entry) => entry.id === original.id);
      if (!event && original.itemId === null && original.kind === 'busy') continue;
      if (!event || event.itemId !== original.itemId || event.kind !== original.kind) throw invalid('현재 일정 항목을 제거하거나 바꿀 수 없습니다.');
      event.start = original.start;
      event.end = original.end;
      const item = workspace.snapshot.blocks.flatMap((block) => block.items).find((entry) => entry.id === event.itemId);
      if (item) { event.locked ||= item.locked; event.completed ||= item.completed; }
    }
    if (input.events.some((event) => !baseline.some((old) => old.id === event.id) && (event.itemId !== null || event.kind !== 'busy' || !event.locked))) {
      throw invalid('추가 조건은 이동하지 않는 점유 시간만 지원합니다.');
    }
    let result = repairSchedule(input);
    if (result.status === 'invalid_input' || result.status === 'unsupported') throw invalid(result.message);
    const conditionRevision = previous.condition_revision + 1;
    if (conditionRevision > 20) throw new ApiException('RECOVERY_LIMIT', '이 작업의 조건 변경 한도에 도달했습니다. 새 작업을 만들어 주세요.', 429);
    const proposalId = randomId('repair');
    const sourceId = randomId('src');
    const now = nowIso();
    const sourceText = [
      `사용자가 확인한 일정 조건 ${conditionRevision} · ${input.timezone} · 기준 ${input.now}`,
      ...input.sources.filter((source) => !workspace.sources.some((stored) => stored.text.includes(source.text))).map((source) => source.text),
      `변경 요청: ${JSON.stringify(input.change)}`,
      `가용 시간: ${JSON.stringify(input.workWindows)}`,
      ...input.events.map((event) => `${event.title}: ${recoverySlotText(event)}; ${event.kind}; 고정 ${event.locked}; 완료 ${event.completed}; 이동 범위 ${JSON.stringify(event.movableWindow)}`),
    ].join('\n');
    if (sourceText.length > LIMITS.sourceChars || workspace.sources.length >= LIMITS.maxSources ||
        workspace.sources.reduce((sum, source) => sum + source.text.length, 0) + sourceText.length > LIMITS.totalSourceChars) {
      throw new ApiException('SOURCE_LIMIT', '저장할 원문과 조건의 크기 한도에 도달했습니다.', 413);
    }
    input = bindRecoverySources(input, [...workspace.sources.map(({ id, text }) => ({ id, text })), { id: sourceId, text: sourceText }]);
    result = repairSchedule(input);
    const response: RecoveryView = { workspaceId, revision: workspace.revision, sourceRevision: input.sourceRevision, conditionRevision, input, result, proposalId, applied: false, actions: [] };
    const guard = randomId('guard');
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(`INSERT INTO tx_guards(id,created_at) SELECT ?,? FROM workspaces w JOIN recovery_profiles p ON p.workspace_id=w.id
          WHERE w.id=? AND w.owner_id=? AND w.revision=? AND w.source_revision=? AND w.deleted_at IS NULL AND w.expires_at>?
          AND w.pending_changeset_json IS NULL AND p.condition_revision=?
          AND NOT EXISTS(SELECT 1 FROM recovery_actions a WHERE a.workspace_id=w.id AND a.status IN ('queued','executing','uncertain'))`)
          .bind(guard, now, workspaceId, ownerId, workspace.revision, workspace.sourceRevision, now, previous.condition_revision),
        this.env.DB.prepare('INSERT INTO sources(id,workspace_id,source_revision,title,relation,target_source_id,hash,text,created_at) SELECT ?,?,?,?,"addition",NULL,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(sourceId, workspaceId, input.sourceRevision, '확인한 일정 재배치 조건', await sha256Hex(sourceText), sourceText, now, guard),
        this.env.DB.prepare('INSERT INTO recovery_versions(workspace_id,condition_revision,input_json,source_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(workspaceId, conditionRevision, JSON.stringify(input), sourceId, now, guard),
        this.env.DB.prepare('UPDATE recovery_profiles SET condition_revision=?,base_revision=?,base_source_revision=?,input_json=?,proposal_id=?,applied_revision=NULL,updated_at=? WHERE workspace_id=? AND EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(conditionRevision, workspace.revision, input.sourceRevision, JSON.stringify(input), proposalId, now, workspaceId, guard),
        this.env.DB.prepare('UPDATE workspaces SET source_revision=source_revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM tx_guards WHERE id=?)').bind(now, workspaceId, guard),
        this.env.DB.prepare('INSERT INTO recovery_requests(owner_id,request_id,workspace_id,payload_hash,response_json,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tx_guards WHERE id=?)')
          .bind(ownerId, command.requestId, workspaceId, hash, JSON.stringify(response), now, guard),
        this.env.DB.prepare('INSERT INTO tx_abort(id) SELECT "abort" WHERE NOT EXISTS(SELECT 1 FROM tx_guards WHERE id=?)').bind(guard),
        this.env.DB.prepare('DELETE FROM tx_guards WHERE id=?').bind(guard),
      ]);
    } catch (error) {
      const saved = await this.replay(ownerId, workspaceId, command.requestId, hash);
      if (saved) return saved;
      if (error instanceof ApiException) throw error;
      throw new ApiException('CONCURRENT_MUTATION', '작업이나 실행 상태가 바뀌었습니다. 다시 불러와 주세요.', 409);
    }
    return this.read(ownerId, workspaceId);
  }

  async apply(ownerId: string, workspaceId: string, command: z.infer<typeof applyRecoverySchema>): Promise<RecoveryView> {
    await new WorkspaceStore(this.env).getWorkspace(ownerId, workspaceId);
    await assertOriginStillCurrent(this.env.DB, ownerId, workspaceId);
    const profile = await this.profile(workspaceId);
    const input = recoveryInputSchema.parse(JSON.parse(profile.input_json));
    const edits = buildRecoveryEdits(input);
    await new WorkspaceStore(this.env).applyRecoveryEdits(ownerId, workspaceId, {
      ...command, sourceRevision: profile.base_source_revision, edits,
    }, corePort);
    return this.read(ownerId, workspaceId);
  }

  private async profile(workspaceId: string): Promise<Profile> {
    const profile = await this.env.DB.prepare('SELECT * FROM recovery_profiles WHERE workspace_id=?').bind(workspaceId).first<Profile>();
    if (!profile) throw new ApiException('RECOVERY_NOT_FOUND', '이 작업 공간에는 일정 조정 조건이 없습니다.', 404);
    return profile;
  }

  private assertBase(workspace: WorkspaceView, profile: Profile, revision: number, conditionRevision: number): void {
    if (workspace.revision !== revision || profile.condition_revision !== conditionRevision || workspace.pending) {
      throw new ApiException('STALE_REVISION', '계획이나 조건이 변경되었습니다. 다시 불러와 주세요.', 409);
    }
    if (profile.base_source_revision !== workspace.sourceRevision) throw new ApiException('STALE_SOURCE', '새 원문이 추가되었습니다. 일정 조건을 다시 확인해 주세요.', 409);
    if (workspace.revision !== profile.base_revision && workspace.revision !== profile.applied_revision) {
      throw new ApiException('STALE_RECOVERY_BASE', '작업 공간에서 일정을 직접 수정하거나 복원했습니다. 기존 일정 조정안으로 덮어쓸 수 없습니다.', 409);
    }
  }

  private async replay(ownerId: string, workspaceId: string, requestId: string, hash: string): Promise<RecoveryView | null> {
    await new WorkspaceStore(this.env).getWorkspace(ownerId, workspaceId);
    const row = await this.env.DB.prepare('SELECT payload_hash,response_json FROM recovery_requests WHERE owner_id=? AND request_id=? AND workspace_id=?').bind(ownerId, requestId, workspaceId).first<{ payload_hash: string; response_json: string }>();
    if (!row) return null;
    if (row.payload_hash !== hash) throw new ApiException('IDEMPOTENCY_CONFLICT', '같은 요청 번호로 다른 변경을 저장할 수 없습니다.', 409);
    return JSON.parse(row.response_json) as RecoveryView;
  }
}

const invalid = (message: string) => new ApiException('INVALID_RECOVERY', message, 422);

export function readyRecovery(result: RecoveryResult) {
  if (result.status !== 'ready') throw invalid(result.message);
  return result;
}
