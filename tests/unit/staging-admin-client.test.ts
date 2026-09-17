import { describe, expect, it, vi } from 'vitest';
import { createStagingAdminClient } from '../../scripts/staging-admin-client';

const token = async () => 'synthetic-private-token';
const ok = (results: Record<string, unknown>[] = []) => Response.json({ success: true, result: [{ success: true, results }] });

describe('pinned staging administrative transport', () => {
  it('sends all seed statements as one batch without redirecting credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, result: [{ success: true }, { success: true }] }));
    const client = await createStagingAdminClient({ allowRemoteMutation: true, token, fetch });
    await client.query(['SELECT 1', 'SELECT 2'], false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/accounts/d77fd515103009a324bebb3ac5b81fd9/d1/database/53421a70-d819-4ae6-9eb5-f558a119ea6b/query');
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', body: JSON.stringify({ batch: [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }] }) });
  });

  it('refuses mutation without the gate and rejects non-owned queue messages', async () => {
    const fetch = vi.fn();
    const reader = await createStagingAdminClient({ allowRemoteMutation: false, token, fetch });
    await expect(reader.query(['DELETE FROM tx_guards'], true)).rejects.toMatchObject({ code: 'remote_mutation_not_allowed' });
    await expect(reader.query(['SELECT 1; DELETE FROM tx_guards'], false)).rejects.toMatchObject({ code: 'invalid_staging_read_query' });
    await expect(reader.verifyAtomicBatch()).rejects.toMatchObject({ code: 'remote_mutation_not_allowed' });
    const writer = await createStagingAdminClient({ allowRemoteMutation: true, token, fetch });
    await expect(writer.sendQueueMessage('run_user_owned')).rejects.toMatchObject({ code: 'unsafe_staging_run_id' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never retries an unknown transport outcome or retains provider details', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('synthetic-private-provider-content'));
    const client = await createStagingAdminClient({ allowRemoteMutation: true, token, fetch });
    const error = await client.query(['SELECT 1'], false).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'staging_api_outcome_unknown' });
    expect(String(error)).not.toContain('synthetic-private');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requires a constraint rejection AND absence of the first write to prove atomic rollback', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: 'CHECK constraint failed: synthetic-private-SQL' }] }, { status: 400 }))
      .mockResolvedValueOnce(ok([{ count: 0 }]))
      .mockResolvedValueOnce(ok());
    const client = await createStagingAdminClient({ allowRemoteMutation: true, token, fetch });
    expect(await client.verifyAtomicBatch()).toEqual({ constraintRejected: true, guardRowsAfterFailure: 0 });
    const requests = fetch.mock.calls.map((call) => JSON.parse(call[1].body).batch as { sql: string }[]);
    expect(requests[0]).toHaveLength(2);
    const id = requests[0][0].sql.match(/ops_guard_[a-f0-9]{32}/)?.[0];
    expect(id).toBeTruthy();
    expect(requests[1][0].sql).toContain(id);
    expect(requests[2][0].sql).toBe(`DELETE FROM tx_guards WHERE id = '${id}'`);
  });

  it.each([false, true])('rejects an unproved rollback and still cleans only its guard (constraint: %s)', async (constraint) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: false, errors: [{ message: constraint ? 'CHECK constraint failed' : 'private authentication failure' }] }, { status: 400 }));
    if (constraint) fetch.mockResolvedValueOnce(ok([{ count: 1 }]));
    fetch.mockResolvedValueOnce(ok());
    const client = await createStagingAdminClient({ allowRemoteMutation: true, token, fetch });
    await expect(client.verifyAtomicBatch()).rejects.toMatchObject({ code: constraint ? 'staging_batch_not_atomic' : 'staging_api_rejected' });
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).batch[0].sql).toMatch(/^DELETE FROM tx_guards WHERE id = 'ops_guard_[a-f0-9]{32}'$/);
  });
});
