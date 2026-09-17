import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, LIMITS } from '../../src/core/contracts';
import { MODEL_POLICY, modelCostMicroUsd } from '../../src/core/model-policy';
import { assertModelInputBudget, generateProposal, type ProposalInput } from '../../src/server/model';

const input: ProposalInput = { purpose: '합성 모델 경계 검사', snapshot: emptySnapshot(), sources: [] };
const model = MODEL_POLICY.id;
const draft = { schemaVersion: 2, summary: '합성 HTTP 응답', questions: [], facts: [], blocks: [], removedItems: [] };
function response(overrides: Record<string, unknown> = {}) {
  return Response.json({ responseId: 'synthetic-response', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(draft) }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34, thoughtsTokenCount: 8, totalTokenCount: 54 }, ...overrides });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Gemini paid model boundary', () => {
  it('rejects legacy live responses while retaining measured usage', async () => {
    const legacy = { summary: 'old contract', questions: [], facts: [], blocks: [], removedItems: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(legacy) }] } }] })));
    await expect(generateProposal(input, { apiKey: 'synthetic-test-key', model })).rejects.toMatchObject({ code: 'MODEL_INVALID_OUTPUT', usage: { inputTokens: 12, outputTokens: 42 } });
  });

  it('counts schema and UTF-8 input before issuing HTTP', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const large: ProposalInput = { ...input, sources: [{ id: 'large', title: '합성 긴 자료', text: '한'.repeat(3900), relation: 'initial', targetSourceId: null, hash: 'synthetic', createdAt: '2026-09-09T00:00:00.000Z' }] };
    expect(() => assertModelInputBudget(large)).toThrow();
    await expect(generateProposal(large, { apiKey: 'synthetic-test-key', model })).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects missing credentials and unpriced models before HTTP', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(generateProposal(input, { model })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    await expect(generateProposal(input, { apiKey: 'synthetic-test-key', model: 'unpriced-model' })).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('stops before HTTP when promotional pricing expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MODEL_POLICY.priceValidUntil));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(generateProposal(input, { apiKey: 'synthetic-test-key', model })).rejects.toMatchObject({ code: 'MODEL_PRICING_EXPIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses separate instructions/data, structured schema, no storage and no key in URL', async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetch);
    const result = await generateProposal(input, { apiKey: 'synthetic-test-key', model });
    expect(result).toMatchObject({ inputTokens: 12, outputTokens: 42, costMicroUsd: 167 });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'synthetic-test-key' });
    expect(init.redirect).toBe('manual');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ store: false, systemInstruction: { parts: [{ text: expect.any(String) }] }, contents: [{ role: 'user' }], generationConfig: { maxOutputTokens: LIMITS.outputTokens, responseMimeType: 'application/json', responseJsonSchema: { additionalProperties: false }, thinkingConfig: { thinkingLevel: 'low', includeThoughts: false } } });
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({ purpose: input.purpose, snapshot: input.snapshot, sources: input.sources });
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig.responseJsonSchema.properties.summary.minLength).toBeUndefined();
    expect(body.generationConfig.responseJsonSchema.properties.summary.maxLength).toBeUndefined();
    const wireSchema = JSON.stringify(body.generationConfig.responseJsonSchema);
    expect(wireSchema).not.toMatch(/"(?:minItems|maxItems)":/);
    expect(wireSchema).toContain('"enum":["divide"]');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(LIMITS.reserveMicroUsd).toBe(modelCostMicroUsd(LIMITS.inputTokens, LIMITS.outputTokens));
  });
  it.each([
    null,
    { promptTokenCount: 12, candidatesTokenCount: 34 },
    { promptTokenCount: 12, totalTokenCount: 10 },
    { promptTokenCount: 12, candidatesTokenCount: 34, thoughtsTokenCount: 8, totalTokenCount: 46 },
  ])('retains reservation for missing or inconsistent usage', async (usageMetadata) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ usageMetadata })));
    expect(await generateProposal(input, { apiKey: 'synthetic-test-key', model })).toMatchObject({ costMicroUsd: LIMITS.reserveMicroUsd, inputTokens: null, outputTokens: null });
  });
  it('counts hidden thinking from total usage when breakdown is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ usageMetadata: { promptTokenCount: 12, totalTokenCount: 54 } })));
    expect(await generateProposal(input, { apiKey: 'synthetic-test-key', model })).toMatchObject({ inputTokens: 12, outputTokens: 42, costMicroUsd: 167 });
  });
  it('rejects incomplete or blocked output without reflecting provider details', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'private incomplete output' }] } }] })).mockResolvedValueOnce(response({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(generateProposal(input, { apiKey: 'synthetic-test-key', model })).rejects.toMatchObject({ code: 'MODEL_NOT_COMPLETED' });
    await expect(generateProposal(input, { apiKey: 'synthetic-test-key', model })).rejects.toMatchObject({ code: 'MODEL_REFUSAL' });
  });
  it('excludes thought parts from JSON validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private thought' }, { text: JSON.stringify(draft) }] } }] })));
    expect((await generateProposal(input, { apiKey: 'synthetic-test-key', model })).draft).toEqual(draft);
  });
  it.each([
    { ...draft, summary: 'x'.repeat(601) },
    { ...draft, questions: Array.from({ length: 6 }, () => '합성 질문') },
  ])('enforces local constraints omitted from the provider schema and retains usage', async (invalidDraft) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(invalidDraft) }] } }] })));
    await expect(generateProposal(input, { apiKey: 'synthetic-test-key', model })).rejects.toMatchObject({ code: 'MODEL_INVALID_OUTPUT', usage: { inputTokens: 12, outputTokens: 42, costMicroUsd: 167 } });
  });
  it('returns only safe HTTP metadata for a provider rejection and never retries', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: { message: 'synthetic-private-provider-detail' } }, { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    let failure: unknown;
    try { await generateProposal(input, { apiKey: 'synthetic-test-key', model }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: 'ModelHttpError', status: 429 });
    expect(String(failure) + JSON.stringify(failure)).not.toContain('synthetic-private');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry a network failure whose billing outcome is unknown', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('synthetic network disconnect'));
    vi.stubGlobal('fetch', fetch);
    await expect(generateProposal(input, { apiKey: 'synthetic-test-key', model })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
