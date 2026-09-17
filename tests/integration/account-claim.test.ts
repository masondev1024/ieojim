/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptySnapshot, type ChangeSet } from '../../src/core/contracts';
import { AccountStore } from '../../src/server/account-store';
import { sha256Hex } from '../../src/server/crypto';
import { WorkspaceStore } from '../../src/server/db';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;
const createdAt = '2026-09-10T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('account guest claim persistence', () => {
  it('links a guest owner to an account without reparenting workspaces, runs, commands, or ledgers', async () => {
    const guest = await seedGuestOwner('guest-a', { workspaces: 2, pendingRun: true, ledger: true, command: true });
    const store = new AccountStore(testEnv.DB);
    const preview = await store.previewGuest('acct-a', guest.tokenHash);
    expect(preview?.workspaces).toHaveLength(2);

    const result = await store.claimGuest('acct-a', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash });

    expect(result).toEqual({ claimedCount: 2, workspaceIds: guest.workspaceIds });
    expect(await ownerValue(guest.ownerId, 'account_id')).toBe('acct-a');
    expect(await ownerValue(guest.ownerId, 'credential_version')).toBe(1);
    expect(await ownerValue(guest.ownerId, 'token_hash')).not.toBe(guest.tokenHash);
    expect(await ownedWorkspaceIds(guest.ownerId)).toEqual(guest.workspaceIds);
    expect(await runOwnerIds(guest.ownerId)).toEqual([guest.ownerId]);
    expect(await ledgerOwnerIds(guest.ownerId)).toEqual([guest.ownerId]);
    expect(await commandOwnerIds(guest.ownerId)).toEqual([guest.ownerId]);
    expect((await store.listAccountWorkspaces('acct-a')).map((workspace) => workspace.id)).toEqual(guest.workspaceIds);
  });

  it('replays the original claim after the guest cookie hash is unavailable', async () => {
    const guest = await seedGuestOwner('guest-replay', { workspaces: 1 });
    const store = new AccountStore(testEnv.DB);
    const preview = await store.previewGuest('acct-replay', guest.tokenHash);
    const requestId = crypto.randomUUID();
    const first = await store.claimGuest('acct-replay', guest.tokenHash, { requestId, previewHash: preview!.previewHash });
    const replay = await store.claimGuest('acct-replay', null, { requestId, previewHash: preview!.previewHash });

    expect(replay).toEqual(first);
    const claims = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM account_claims WHERE account_id = ?').bind('acct-replay').first<{ count: number }>();
    expect(claims?.count).toBe(1);
  });

  it('replays a simultaneous same request when another claim commits before this batch', async () => {
    const guest = await seedGuestOwner('guest-same-race', { workspaces: 1 });
    const baseStore = new AccountStore(testEnv.DB);
    const preview = await baseStore.previewGuest('acct-same-race', guest.tokenHash);
    const input = { requestId: crypto.randomUUID(), previewHash: preview!.previewHash };
    let raced = false;
    const interleaving = withBatchInterleaving(testEnv.DB, async () => {
      if (raced) return;
      raced = true;
      await new AccountStore(testEnv.DB).claimGuest('acct-same-race', guest.tokenHash, input);
    });
    const racingStore = new AccountStore(interleaving.db);

    const result = await racingStore.claimGuest('acct-same-race', guest.tokenHash, input);

    expect(interleaving.injected()).toBe(true);
    expect(result).toEqual({ claimedCount: 1, workspaceIds: guest.workspaceIds });
    expect(await ownerValue(guest.ownerId, 'account_id')).toBe('acct-same-race');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM account_claims WHERE account_id = ?').bind('acct-same-race').first('count')).toBe(1);
    expect(await txGuardCount()).toBe(0);
  });

  it('preserves a 409 idempotency conflict for the same request with a different preview hash', async () => {
    const guest = await seedGuestOwner('guest-conflicting-replay', { workspaces: 1 });
    const store = new AccountStore(testEnv.DB);
    const preview = await store.previewGuest('acct-conflicting-replay', guest.tokenHash);
    const requestId = crypto.randomUUID();
    await store.claimGuest('acct-conflicting-replay', guest.tokenHash, { requestId, previewHash: preview!.previewHash });

    await expect(store.claimGuest('acct-conflicting-replay', null, { requestId, previewHash: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('rejects foreign or already-claimed guest owners and preserves the original owner mapping', async () => {
    const guest = await seedGuestOwner('guest-foreign', { workspaces: 1 });
    const store = new AccountStore(testEnv.DB);
    const preview = await store.previewGuest('acct-owner', guest.tokenHash);
    await store.claimGuest('acct-owner', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash });

    await expect(store.previewGuest('acct-other', guest.tokenHash)).resolves.toBeNull();
    await expect(store.claimGuest('acct-other', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash }))
      .rejects.toMatchObject({ code: 'GUEST_CLAIM_STALE', status: 409 });
    expect(await ownerValue(guest.ownerId, 'account_id')).toBe('acct-owner');
  });

  it('rejects changed guest snapshots and rolls back every claim side effect', async () => {
    const guest = await seedGuestOwner('guest-changed', { workspaces: 1 });
    const store = new AccountStore(testEnv.DB);
    const preview = await store.previewGuest('acct-changed', guest.tokenHash);
    await testEnv.DB.prepare('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').bind(guest.workspaceIds[0]).run();

    await expect(store.claimGuest('acct-changed', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash }))
      .rejects.toMatchObject({ code: 'GUEST_CLAIM_STALE', status: 409 });
    expect(await ownerValue(guest.ownerId, 'account_id')).toBeNull();
    expect(await ownerValue(guest.ownerId, 'credential_version')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM account_claims WHERE account_id = ?').bind('acct-changed').first('count')).toBe(0);
    expect(await txGuardCount()).toBe(0);
  });

  it('rejects a revision change after preflight but before the claim batch and rolls back', async () => {
    const guest = await seedGuestOwner('guest-batch-revision', { workspaces: 1 });
    const baseStore = new AccountStore(testEnv.DB);
    const preview = await baseStore.previewGuest('acct-batch-revision', guest.tokenHash);
    const interleaving = withBatchInterleaving(testEnv.DB, async () => {
      await testEnv.DB.prepare('UPDATE workspaces SET revision = revision + 1 WHERE id = ?').bind(guest.workspaceIds[0]).run();
    });
    const racingStore = new AccountStore(interleaving.db);

    await expect(racingStore.claimGuest('acct-batch-revision', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash }))
      .rejects.toMatchObject({ code: 'GUEST_CLAIM_STALE', status: 409 });
    expect(interleaving.injected()).toBe(true);
    expect(await ownerValue(guest.ownerId, 'account_id')).toBeNull();
    expect(await ownerValue(guest.ownerId, 'credential_version')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM account_claims WHERE account_id = ?').bind('acct-batch-revision').first('count')).toBe(0);
    expect(await txGuardCount()).toBe(0);
  });

  it('rejects new guest workspaces between preview and claim and rolls back', async () => {
    const guest = await seedGuestOwner('guest-new-workspace', { workspaces: 1 });
    const store = new AccountStore(testEnv.DB);
    const preview = await store.previewGuest('acct-new-workspace', guest.tokenHash);
    await seedWorkspace(guest.ownerId, 'guest-new-workspace-extra');

    await expect(store.claimGuest('acct-new-workspace', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash }))
      .rejects.toMatchObject({ code: 'GUEST_CLAIM_STALE', status: 409 });
    expect(await ownerValue(guest.ownerId, 'account_id')).toBeNull();
    expect(await txGuardCount()).toBe(0);
  });

  it('rejects a new guest workspace after preflight but before the claim batch and rolls back', async () => {
    const guest = await seedGuestOwner('guest-batch-new-workspace', { workspaces: 1 });
    const baseStore = new AccountStore(testEnv.DB);
    const preview = await baseStore.previewGuest('acct-batch-new-workspace', guest.tokenHash);
    const interleaving = withBatchInterleaving(testEnv.DB, async () => {
      await seedWorkspace(guest.ownerId, 'guest-batch-new-workspace-extra');
    });
    const racingStore = new AccountStore(interleaving.db);

    await expect(racingStore.claimGuest('acct-batch-new-workspace', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash }))
      .rejects.toMatchObject({ code: 'GUEST_CLAIM_STALE', status: 409 });
    expect(interleaving.injected()).toBe(true);
    expect(await ownerValue(guest.ownerId, 'account_id')).toBeNull();
    expect(await txGuardCount()).toBe(0);
  });

  it('rejects claims that would exceed the account workspace cap', async () => {
    const guest = await seedGuestOwner('guest-cap', { workspaces: 2 });
    const store = new AccountStore(testEnv.DB);
    await store.ensureAccount('acct-cap');
    const accountOwner = await store.getPrimaryOwner('acct-cap');
    for (let index = 0; index < 9; index += 1) await seedWorkspace(accountOwner!.ownerId, `acct-existing-${index}`);
    const preview = await store.previewGuest('acct-cap', guest.tokenHash);

    await expect(store.claimGuest('acct-cap', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash }))
      .rejects.toMatchObject({ code: 'ACCOUNT_WORKSPACE_LIMIT', status: 409 });
    expect(await ownerValue(guest.ownerId, 'account_id')).toBeNull();
    expect((await store.listAccountWorkspaces('acct-cap')).map((workspace) => workspace.id)).toHaveLength(9);
  });

  it('rejects an account cap race after preflight but before the claim batch and rolls back', async () => {
    const guest = await seedGuestOwner('guest-batch-cap', { workspaces: 2 });
    const baseStore = new AccountStore(testEnv.DB);
    await baseStore.ensureAccount('acct-batch-cap');
    const accountOwner = await baseStore.getPrimaryOwner('acct-batch-cap');
    for (let index = 0; index < 8; index += 1) await seedWorkspace(accountOwner!.ownerId, `acct-batch-cap-existing-${index}`);
    const preview = await baseStore.previewGuest('acct-batch-cap', guest.tokenHash);
    const interleaving = withBatchInterleaving(testEnv.DB, async () => {
      await seedWorkspace(accountOwner!.ownerId, 'acct-batch-cap-race');
    });
    const racingStore = new AccountStore(interleaving.db);

    await expect(racingStore.claimGuest('acct-batch-cap', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash }))
      .rejects.toMatchObject({ code: 'GUEST_CLAIM_STALE', status: 409 });
    expect(interleaving.injected()).toBe(true);
    expect(await ownerValue(guest.ownerId, 'account_id')).toBeNull();
    expect((await baseStore.listAccountWorkspaces('acct-batch-cap')).map((workspace) => workspace.id)).toHaveLength(9);
    expect(await txGuardCount()).toBe(0);
  });

  it('lets an admitted active run finish after the guest owner is claimed', async () => {
    const guest = await seedGuestOwner('guest-active-run', { workspaces: 1, pendingRun: true, ledger: true });
    const accountStore = new AccountStore(testEnv.DB);
    const preview = await accountStore.previewGuest('acct-active-run', guest.tokenHash);
    await accountStore.claimGuest('acct-active-run', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash });
    const workspaceStore = new WorkspaceStore(testEnv);
    const run = await workspaceStore.claimRun('guest-active-run-run');
    expect(run).toMatchObject({ owner_id: guest.ownerId, workspace_id: guest.workspaceIds[0], status: 'running' });
    const context = await workspaceStore.runContext(run!);

    const outcome = await workspaceStore.completeRun(run!, changeSet(context.workspace.id), 42);

    expect(outcome).toMatchObject({ outcome: 'published', status: 'ready', changesetId: 'cs_account_claim_run' });
    const row = await testEnv.DB.prepare('SELECT status, owner_id, actual_micro_usd FROM runs WHERE id = ?').bind('guest-active-run-run').first<{ status: string; owner_id: string; actual_micro_usd: number }>();
    expect(row).toMatchObject({ status: 'ready', owner_id: guest.ownerId, actual_micro_usd: 42 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM budget_ledger WHERE run_id = ? AND entry_type = "actual" AND owner_id = ?').bind('guest-active-run-run', guest.ownerId).first('count')).toBe(1);
  });

  it('previews and claims only active guest workspaces without resurrecting expired or deleted data', async () => {
    const guest = await seedGuestOwner('guest-retention', { workspaces: 1 });
    const expiredId = await seedWorkspace(guest.ownerId, 'guest-retention-expired', '2000-01-01T00:00:00.000Z');
    const deletedId = await seedWorkspace(guest.ownerId, 'guest-retention-deleted');
    await testEnv.DB.prepare('UPDATE workspaces SET deleted_at = ? WHERE id = ?').bind(createdAt, deletedId).run();
    const store = new AccountStore(testEnv.DB);
    const preview = await store.previewGuest('acct-retention', guest.tokenHash);

    expect(preview?.workspaces.map((workspace) => workspace.id)).toEqual(guest.workspaceIds);
    const result = await store.claimGuest('acct-retention', guest.tokenHash, { requestId: crypto.randomUUID(), previewHash: preview!.previewHash });

    expect(result.workspaceIds).toEqual(guest.workspaceIds);
    expect((await store.listAccountWorkspaces('acct-retention')).map((workspace) => workspace.id)).toEqual(guest.workspaceIds);
    expect(await testEnv.DB.prepare('SELECT owner_id FROM workspaces WHERE id = ?').bind(expiredId).first('owner_id')).toBe(guest.ownerId);
    expect(await testEnv.DB.prepare('SELECT deleted_at FROM workspaces WHERE id = ?').bind(deletedId).first('deleted_at')).toBe(createdAt);
  });
});

async function seedGuestOwner(idPrefix: string, options: { workspaces: number; pendingRun?: boolean; ledger?: boolean; command?: boolean }) {
  const ownerId = `${idPrefix}-owner`;
  const tokenHash = await sha256Hex(`${idPrefix}-token`);
  await testEnv.DB.prepare('INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .bind(ownerId, tokenHash, createdAt, createdAt)
    .run();

  const workspaceIds: string[] = [];
  for (let index = 0; index < options.workspaces; index += 1) {
    workspaceIds.push(await seedWorkspace(ownerId, `${idPrefix}-workspace-${index}`));
  }
  if (options.pendingRun) await seedPendingRun(ownerId, workspaceIds[0], `${idPrefix}-run`);
  if (options.ledger) {
    await testEnv.DB.prepare('INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES (?, ?, ?, ?, "reserve", 100, ?)')
      .bind(`${idPrefix}-ledger`, ownerId, workspaceIds[0], `${idPrefix}-run`, createdAt)
      .run();
  }
  if (options.command) {
    await testEnv.DB.prepare('INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) VALUES (?, ?, ?, ?, "manual_edit", "hash", "{}", ?)')
      .bind(`${idPrefix}-command`, ownerId, workspaceIds[0], crypto.randomUUID(), createdAt)
      .run();
  }
  return { ownerId, tokenHash, workspaceIds };
}

async function seedWorkspace(ownerId: string, id: string, workspaceExpiresAt = expiresAt): Promise<string> {
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, created_at, updated_at, expires_at) VALUES (?, ?, ?, "purpose", 0, 0, 0, ?, ?, ?)')
      .bind(id, ownerId, `Workspace ${id}`, createdAt, createdAt, workspaceExpiresAt),
    testEnv.DB.prepare('INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) VALUES (?, 0, ?, "created", ?)')
      .bind(id, JSON.stringify(emptySnapshot()), createdAt),
  ]);
  return id;
}

async function seedPendingRun(ownerId: string, workspaceId: string, runId: string): Promise<void> {
  const sourceId = `${runId}-source`;
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) VALUES (?, ?, 1, "source", "initial", NULL, ?, "source text", ?)')
      .bind(sourceId, workspaceId, `${runId}-source-hash`, createdAt),
    testEnv.DB.prepare('UPDATE workspaces SET source_revision = 1 WHERE id = ?').bind(workspaceId),
    testEnv.DB.prepare('INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, created_at, updated_at) VALUES (?, ?, ?, ?, "pending", "live", ?, "payload", 0, 1, 100, ?, ?)')
      .bind(runId, workspaceId, ownerId, sourceId, crypto.randomUUID(), createdAt, createdAt),
  ]);
}

async function ownerValue(ownerId: string, column: 'account_id' | 'credential_version' | 'token_hash') {
  return testEnv.DB.prepare(`SELECT ${column} FROM owners WHERE id = ?`).bind(ownerId).first(column);
}

async function ownedWorkspaceIds(ownerId: string): Promise<string[]> {
  const rows = await testEnv.DB.prepare('SELECT id FROM workspaces WHERE owner_id = ? ORDER BY updated_at DESC, id ASC').bind(ownerId).all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

async function runOwnerIds(ownerId: string): Promise<string[]> {
  const rows = await testEnv.DB.prepare('SELECT DISTINCT owner_id FROM runs WHERE owner_id = ?').bind(ownerId).all<{ owner_id: string }>();
  return (rows.results ?? []).map((row) => row.owner_id);
}

async function ledgerOwnerIds(ownerId: string): Promise<string[]> {
  const rows = await testEnv.DB.prepare('SELECT DISTINCT owner_id FROM budget_ledger WHERE owner_id = ?').bind(ownerId).all<{ owner_id: string }>();
  return (rows.results ?? []).map((row) => row.owner_id);
}

async function commandOwnerIds(ownerId: string): Promise<string[]> {
  const rows = await testEnv.DB.prepare('SELECT DISTINCT owner_id FROM applied_commands WHERE owner_id = ?').bind(ownerId).all<{ owner_id: string }>();
  return (rows.results ?? []).map((row) => row.owner_id);
}

async function txGuardCount(): Promise<number> {
  return await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM tx_guards').first('count') ?? -1;
}

function withBatchInterleaving(db: D1Database, beforeClaimBatch: () => Promise<void>): { db: D1Database; injected: () => boolean } {
  let triggered = false;
  const sqlByStatement = new WeakMap<D1PreparedStatement, string>();
  const proxiedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          sqlByStatement.set(statement, sql);
          return wrapStatement(statement, sql, sqlByStatement);
        };
      }
      if (property !== 'batch') return Reflect.get(target, property, receiver);
      return async (statements: D1PreparedStatement[]) => {
        if (!triggered && isClaimBatch(statements, sqlByStatement)) {
          triggered = true;
          await beforeClaimBatch();
        }
        return target.batch(statements);
      };
    },
  });
  return { db: proxiedDb, injected: () => triggered };
}

function wrapStatement(statement: D1PreparedStatement, sql: string, sqlByStatement: WeakMap<D1PreparedStatement, string>): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property, receiver) {
      if (property !== 'bind') return Reflect.get(target, property, receiver);
      return (...values: unknown[]) => {
        const bound = target.bind(...values);
        sqlByStatement.set(bound, sql);
        return bound;
      };
    },
  });
}

function isClaimBatch(statements: D1PreparedStatement[], sqlByStatement: WeakMap<D1PreparedStatement, string>): boolean {
  const sql = statements.map((statement) => sqlByStatement.get(statement) ?? '').join('\n');
  return statements.length === 6 && sql.includes('account_claims') && sql.includes('UPDATE owners SET account_id');
}

function changeSet(workspaceId: string): ChangeSet {
  return {
    id: 'cs_account_claim_run',
    baseRevision: 0,
    baseSourceRevision: 1,
    proposalRevision: 1,
    summary: `claim run ${workspaceId}`,
    questions: [],
    changes: [],
    conflicts: [],
    next: emptySnapshot(),
    createdAt,
  };
}
