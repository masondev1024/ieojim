import { afterEach, expect, it, vi } from 'vitest';
import { emptySnapshot } from '../../src/core/contracts';
import { MODEL_POLICY } from '../../src/core/model-policy';
import { generateProposal } from '../../src/server/model';

afterEach(() => vi.restoreAllMocks());

it('constructs a Workers-compatible request and rejects redirects without forwarding credentials', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    // Exercise the actual Workers Request parser that a plain fetch stub bypasses.
    const request = new Request(input, init);
    expect(request.redirect).toBe('manual');
    return new Response(null, { status: 307, headers: { Location: 'https://untrusted.invalid/' } });
  });
  await expect(generateProposal({ purpose: '합성 런타임 검증', snapshot: emptySnapshot(), sources: [] }, {
    model: MODEL_POLICY.id, apiKey: 'synthetic-runtime-key',
  })).rejects.toMatchObject({ name: 'ModelHttpError', status: 307 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
