/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/core/contracts';
import { pendingCancellationSql, pendingSeedStatements } from '../../scripts/staging-pending-drill';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const ids = {
  owner: 'ops_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  workspace: 'ops_ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  source: 'ops_src_cccccccccccccccccccccccccccccccc',
  run: 'ops_run_dddddddddddddddddddddddddddddddd',
  request: 'ops_req_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  ledger: 'ops_led_ffffffffffffffffffffffffffffffff',
  guard: 'ops_guard_11111111111111111111111111111111',
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('staging pending drill admission SQL', () => {
  it.each([false, true])('cancels only an unclaimed owned run and preserves its reserve (claimed: %s)', async (claimed) => {
    await executeBatch(pendingSeedStatements(ids, '2026-09-09T00:00:00.000Z'));
    if (claimed) await testEnv.DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(ids.run).run();
    await testEnv.DB.prepare(pendingCancellationSql(ids)).run();
    expect(await testEnv.DB.prepare('SELECT status FROM runs WHERE id = ?').bind(ids.run).first('status')).toBe(claimed ? 'running' : 'failed');
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM budget_ledger WHERE run_id = ? AND entry_type = 'reserve'").bind(ids.run).first('count')).toBe(1);
  });

  it('admits the pending fixture only with the same reserve ledger invariant as runtime', async () => {
    await executeBatch(pendingSeedStatements(ids, '2026-09-09T00:00:00.000Z'));

    const counts = await testEnv.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM workspaces WHERE id = ?) AS workspaces,
        (SELECT COUNT(*) FROM sources WHERE id = ? AND hash = '5290338220a3a50f9fbd85600a0c95e63db7160e8c9ec0f844ede7ebe96ba461') AS sources,
        (SELECT COUNT(*) FROM runs WHERE id = ? AND status = 'pending' AND mode = 'live' AND reserved_micro_usd = ?) AS pending_runs,
        (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ? AND entry_type = 'reserve' AND amount_micro_usd = ?) AS reserve_ledgers,
        (SELECT COUNT(*) FROM tx_guards) AS guards
    `).bind(ids.workspace, ids.source, ids.run, LIMITS.reserveMicroUsd, ids.run, LIMITS.reserveMicroUsd).first<{
      workspaces: number;
      sources: number;
      pending_runs: number;
      reserve_ledgers: number;
      guards: number;
    }>();

    expect(counts).toEqual({ workspaces: 1, sources: 1, pending_runs: 1, reserve_ledgers: 1, guards: 0 });
  });

  it('rolls back every seeded row when the staging daily reserve cap is exhausted', async () => {
    await testEnv.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES ('existing_owner', 'existing_hash', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')").run();
    await testEnv.DB.prepare(
      "INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES ('existing_reserve', 'existing_owner', NULL, 'existing_run', 'reserve', ?, '2026-09-09T00:00:00.000Z')",
    ).bind(250000 - LIMITS.reserveMicroUsd + 1).run();

    await expect(executeBatch(pendingSeedStatements(ids, '2026-09-09T00:00:00.000Z'))).rejects.toThrow();

    await expectOwnedRowsGone();
  });

  it('rolls back every seeded row when a model budget policy violation exists', async () => {
    await testEnv.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES ('existing_owner', 'existing_hash', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')").run();
    await testEnv.DB.prepare(
      "INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES ('existing_policy', 'existing_owner', NULL, 'existing_run', 'policy_violation', 1, '2026-09-09T00:00:00.000Z')",
    ).run();

    await expect(executeBatch(pendingSeedStatements(ids, '2026-09-09T00:00:00.000Z'))).rejects.toThrow();

    await expectOwnedRowsGone();
  });

  it('rolls back every seeded row when the staging total reserve cap is exhausted', async () => {
    await testEnv.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES ('existing_owner', 'existing_hash', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')").run();
    await testEnv.DB.prepare(
      "INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES ('existing_total_reserve', 'existing_owner', NULL, 'existing_total_run', 'reserve', ?, '2026-09-08T00:00:00.000Z')",
    ).bind(1000000 - LIMITS.reserveMicroUsd + 1).run();

    await expect(executeBatch(pendingSeedStatements(ids, '2026-09-09T00:00:00.000Z'))).rejects.toThrow();

    await expectOwnedRowsGone();
  });

  it('rolls back every seeded row when the owned daily run cap is exhausted', async () => {
    const statements = pendingSeedStatements(ids, '2026-09-09T00:00:00.000Z');
    const reservationIndex = statements.findIndex((statement) => statement.startsWith('INSERT INTO budget_ledger'));
    expect(reservationIndex).toBeGreaterThan(0);
    const seededOwnerCap = Array.from({ length: 10 }, (_, index) =>
      `INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES ('owner_cap_${index}', '${ids.owner}', NULL, 'owner_cap_run_${index}', 'reserve', 1, '2026-09-09T00:00:00.000Z')`);
    statements.splice(reservationIndex, 0, ...seededOwnerCap);

    await expect(executeBatch(statements)).rejects.toThrow();

    await expectOwnedRowsGone();
    const capLedgers = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM budget_ledger WHERE id LIKE 'owner_cap_%'").first<{ count: number }>();
    expect(capLedgers?.count).toBe(0);
  });
});

async function expectOwnedRowsGone(): Promise<void> {
  const counts = await testEnv.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM owners WHERE id = ?) AS owners,
      (SELECT COUNT(*) FROM workspaces WHERE id = ?) AS workspaces,
      (SELECT COUNT(*) FROM sources WHERE id = ?) AS sources,
      (SELECT COUNT(*) FROM runs WHERE id = ?) AS runs,
      (SELECT COUNT(*) FROM budget_ledger WHERE run_id = ?) AS ledgers,
      (SELECT COUNT(*) FROM tx_guards WHERE id = ?) AS guards
  `).bind(ids.owner, ids.workspace, ids.source, ids.run, ids.run, ids.guard).first<{
    owners: number;
    workspaces: number;
    sources: number;
    runs: number;
    ledgers: number;
    guards: number;
  }>();

  expect(counts).toEqual({ owners: 0, workspaces: 0, sources: 0, runs: 0, ledgers: 0, guards: 0 });
}

async function executeBatch(statements: string[]): Promise<void> {
  await testEnv.DB.batch(statements.map((statement) => testEnv.DB.prepare(statement)));
}
