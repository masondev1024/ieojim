import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type BlockItem, type ProposalDraft, type Snapshot, type Source } from '../../src/core/contracts';
import { MODEL_POLICY } from '../../src/core/model-policy';
import { ApiException } from '../../src/server/errors';
import { generateProposal, type ModelRequestProvenance, type ProposalInput } from '../../src/server/model';

const model = MODEL_POLICY.id;
const draft: ProposalDraft = { schemaVersion: 2, summary: '합성 HTTP 응답', questions: [], facts: [], blocks: [], removedItems: [] };
const source: Source = {
  id: 'src_test',
  title: '합성 자료',
  text: '참석자는 4명입니다.',
  relation: 'initial',
  targetSourceId: null,
  hash: 'synthetic-source-hash',
  createdAt: '2026-09-09T00:00:00.000Z',
};
const item: BlockItem = {
  id: 'item:plan:note',
  key: 'note',
  label: '메모',
  value: '사용자 메모',
  factKeys: [],
  valueFactKey: null,
  calculation: null,
  completed: false,
  locked: false,
  edited: true,
  stale: false,
};
const snapshot: Snapshot = { facts: [], blocks: [{ id: 'block:plan', key: 'plan', type: 'note', title: '계획', items: [item] }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model request provenance', () => {
  it('hashes the exact serialized request body used for fetch', async () => {
    const provenances: ModelRequestProvenance[] = [];
    const fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      expect(provenances[0]?.requestSha256).toBe(await sha256Hex(String(init.body)));
      return response();
    });
    vi.stubGlobal('fetch', fetch);

    await generateProposal({ purpose: '합성 검증', snapshot: emptySnapshot(), sources: [] }, {
      apiKey: 'synthetic-test-key',
      model,
      beforeRequest: (next) => { provenances.push(next); },
    });

    const captured = provenances[0];
    if (!captured) throw new Error('provenance hook was not called');
    expect(captured).toMatchObject({
      schemaVersion: 1,
      modelId: model,
      strategy: 'incremental',
      sourceCount: 0,
      totalSourceTextBytes: 0,
      snapshotFactCount: 0,
      snapshotBlockCount: 0,
      snapshotItemCount: 0,
    });
    expect(captured.requestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.instructionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.localSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.generationConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured.modelPolicySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps identical input provenance stable and changes request hash for source or manual state changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => response()));
    const first = await provenanceFor({ purpose: '합성 검증', snapshot, sources: [source] });
    const second = await provenanceFor({ purpose: '합성 검증', snapshot: structuredClone(snapshot), sources: [structuredClone(source)] });
    const changedSource = await provenanceFor({ purpose: '합성 검증', snapshot, sources: [{ ...source, text: '참석자는 5명입니다.' }] });
    const changedManualState = await provenanceFor({
      purpose: '합성 검증',
      snapshot: { ...snapshot, blocks: [{ ...snapshot.blocks[0], items: [{ ...item, value: '사용자 메모 변경' }] }] },
      sources: [source],
    });

    expect(second).toEqual(first);
    expect(changedSource.requestSha256).not.toBe(first.requestSha256);
    expect(changedManualState.requestSha256).not.toBe(first.requestSha256);
    expect(changedSource.instructionSha256).toBe(first.instructionSha256);
    expect(changedManualState.instructionSha256).toBe(first.instructionSha256);
  });

  it('stops before fetch when the provenance hook fails', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(generateProposal({ purpose: '합성 검증', snapshot: emptySnapshot(), sources: [] }, {
      apiKey: 'synthetic-test-key',
      model,
      beforeRequest: () => {
        throw new ApiException('MODEL_PROVENANCE_UNAVAILABLE', 'synthetic unavailable', 503);
      },
    })).rejects.toMatchObject({ code: 'MODEL_PROVENANCE_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function provenanceFor(input: ProposalInput): Promise<ModelRequestProvenance> {
  let provenance: ModelRequestProvenance | null = null;
  await generateProposal(input, {
    apiKey: 'synthetic-test-key',
    model,
    beforeRequest: (next) => { provenance = next; },
  });
  expect(provenance).toBeTruthy();
  if (!provenance) throw new Error('provenance hook was not called');
  return provenance;
}

function response(): Response {
  return Response.json({
    responseId: 'synthetic-response',
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(draft) }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34, thoughtsTokenCount: 8, totalTokenCount: 54 },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
