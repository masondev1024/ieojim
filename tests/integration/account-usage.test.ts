/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAccountUsage } from '../../src/server/account-usage';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('readAccountUsage', () => {
  it('isolates usage between accounts and does not expose owner IDs or ledger cost fields', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    await seedAccountOwner('acct_a', 'owner_a');
    await seedAccountOwner('acct_b', 'owner_b');
    await seedWorkspace('owner_a', 'workspace_a', { title: 'A workspace', now });
    await seedWorkspace('owner_b', 'workspace_b', { title: 'B workspace', now });
    await seedReserve('owner_a', 'workspace_a', '2026-09-10T01:00:00.000Z');
    await seedReserve('owner_b', 'workspace_b', '2026-09-10T02:00:00.000Z');

    const usage = await readAccountUsage(testEnv.DB, 'acct_a', 10, now);

    expect(usage).toMatchObject({
      asOf: now.toISOString(),
      retentionDays: 7,
      activeWorkspaces: { used: 1, limit: 10 },
      aiRunsToday: { used: 1, limit: 10, resetAt: '2026-09-11T00:00:00.000Z' },
    });
    expect(usage.workspaces).toEqual([{ id: 'workspace_a', title: 'A workspace', revision: 0, sourceRevision: 0, updatedAt: now.toISOString(), expiresAt: expiresFrom(now) }]);
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain('owner_a');
    expect(serialized).not.toContain('owner_id');
    expect(serialized).not.toContain('amount_micro_usd');
    expect(serialized).not.toContain('token_hash');
  });

  it('aggregates claimed account owner buckets and includes deleted-workspace ledger reservations', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    await seedAccountOwner('acct_claimed', 'owner_primary');
    await seedAccountOwner('acct_claimed', 'owner_claimed');
    await seedWorkspace('owner_primary', 'workspace_primary', { title: 'Primary', now });
    await seedWorkspace('owner_claimed', 'workspace_claimed', { title: 'Claimed', now });
    await seedWorkspace('owner_claimed', 'workspace_deleted', { title: 'Deleted', now, deletedAt: '2026-09-10T10:00:00.000Z' });
    await seedReserve('owner_primary', 'workspace_primary', '2026-09-10T00:30:00.000Z');
    await seedReserve('owner_claimed', 'workspace_claimed', '2026-09-10T01:30:00.000Z');
    await seedReserve('owner_claimed', 'workspace_deleted', '2026-09-10T02:30:00.000Z');

    const usage = await readAccountUsage(testEnv.DB, 'acct_claimed', 3, now);

    expect(usage.activeWorkspaces).toEqual({ used: 2, limit: 10 });
    expect(usage.aiRunsToday).toEqual({ used: 3, limit: 3, resetAt: '2026-09-11T00:00:00.000Z' });
    expect(usage.workspaces.map((workspace) => workspace.id).sort()).toEqual(['workspace_claimed', 'workspace_primary']);
  });

  it('excludes expired workspaces without deleting or extending their expiry', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    await seedAccountOwner('acct_expiry', 'owner_expiry');
    await seedWorkspace('owner_expiry', 'workspace_active', { title: 'Active', now });
    await seedWorkspace('owner_expiry', 'workspace_expired', {
      title: 'Expired',
      now,
      expiresAt: '2026-09-10T11:59:59.999Z',
    });
    const before = await workspaceExpiryRows();

    const usage = await readAccountUsage(testEnv.DB, 'acct_expiry', 10, now);
    const after = await workspaceExpiryRows();

    expect(usage.activeWorkspaces).toEqual({ used: 1, limit: 10 });
    expect(usage.workspaces.map((workspace) => workspace.id)).toEqual(['workspace_active']);
    expect(after).toEqual(before);
  });

  it('uses the same UTC day-start admission counter as WorkspaceStore, including future-dated reserves', async () => {
    const now = new Date('2026-09-10T23:59:59.500Z');
    await seedAccountOwner('acct_utc', 'owner_utc');
    await seedWorkspace('owner_utc', 'workspace_utc', { title: 'UTC', now });
    await seedReserve('owner_utc', 'workspace_utc', '2026-09-09T23:59:59.999Z');
    await seedReserve('owner_utc', 'workspace_utc', '2026-09-10T00:00:00.000Z');
    await seedReserve('owner_utc', 'workspace_utc', '2026-09-10T23:59:59.999Z');
    await seedReserve('owner_utc', 'workspace_utc', '2026-09-11T00:00:00.000Z');

    const usage = await readAccountUsage(testEnv.DB, 'acct_utc', 5, now);

    expect(usage.aiRunsToday).toEqual({ used: 3, limit: 5, resetAt: '2026-09-11T00:00:00.000Z' });
  });

  it('is a read-only snapshot and never creates account identity or touches workspace expiry', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    await seedAccountOwner('acct_readonly', 'owner_readonly');
    await seedWorkspace('owner_readonly', 'workspace_readonly', { title: 'Read only', now });
    const ownerCountBefore = await countRows('owners');
    const accountCountBefore = await countRows('app_accounts');
    const expiryBefore = await workspaceExpiryRows();

    const usage = await readAccountUsage(testEnv.DB, 'acct_missing', 10, now);
    const ownerCountAfter = await countRows('owners');
    const accountCountAfter = await countRows('app_accounts');
    const expiryAfter = await workspaceExpiryRows();

    expect(usage.activeWorkspaces).toEqual({ used: 0, limit: 10 });
    expect(usage.aiRunsToday).toEqual({ used: 0, limit: 10, resetAt: '2026-09-11T00:00:00.000Z' });
    expect(ownerCountAfter).toBe(ownerCountBefore);
    expect(accountCountAfter).toBe(accountCountBefore);
    expect(expiryAfter).toEqual(expiryBefore);
  });
});

const seedAccountOwner = async (accountId: string, ownerId: string) => {
  const now = '2026-09-10T00:00:00.000Z';
  await testEnv.DB.prepare('INSERT INTO app_accounts (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(accountId, now)
    .run();
  await testEnv.DB.prepare('INSERT INTO owners (id, token_hash, account_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ownerId, `${ownerId}_hash`, accountId, now, now)
    .run();
};

const seedWorkspace = async (
  ownerId: string,
  workspaceId: string,
  options: { title: string; now: Date; expiresAt?: string; deletedAt?: string },
) => {
  const now = options.now.toISOString();
  await testEnv.DB.prepare(`
    INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at, deleted_at)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)
  `).bind(workspaceId, ownerId, options.title, 'usage test', now, now, options.expiresAt ?? expiresFrom(options.now), options.deletedAt ?? null)
    .run();
};

const seedReserve = async (ownerId: string, workspaceId: string, createdAt: string) => {
  await testEnv.DB.prepare('INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), ownerId, workspaceId, crypto.randomUUID(), 'reserve', 100, createdAt)
    .run();
};

const expiresFrom = (date: Date) => {
  const expires = new Date(date);
  expires.setUTCDate(expires.getUTCDate() + 7);
  return expires.toISOString();
};

const countRows = async (table: 'owners' | 'app_accounts') => Number(await testEnv.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count'));

const workspaceExpiryRows = async () => {
  const rows = await testEnv.DB.prepare('SELECT id, expires_at FROM workspaces ORDER BY id').all<{ id: string; expires_at: string }>();
  return rows.results ?? [];
};
