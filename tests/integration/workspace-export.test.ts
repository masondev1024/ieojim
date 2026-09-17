/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '../../src/core/contracts';
import { MAX_EXPORT_BYTES, workspaceExportSchema } from '../../src/core/export-contracts';
import { sha256Hex } from '../../src/server/crypto';
import { exportWorkspace } from '../../src/server/workspace-export';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

const testEnv = env as TestEnv;
const createdAt = '2026-09-10T00:00:00.000Z';
const updatedAt = '2026-09-10T01:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('workspace current-data export', () => {
  it('exports only the current and immediately previous snapshot, keeping older history out of the copy payload', async () => {
    await seedWorkspace({ ownerId: 'owner_window', workspaceId: 'workspace_window', snapshot: emptySnapshot() });
    for (const revision of [0, 1, 2]) {
      await testEnv.DB.prepare('INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) VALUES (?, ?, ?, "manual_edit", ?)')
        .bind('workspace_window', revision, JSON.stringify(emptySnapshot()), createdAt).run();
    }
    const exported = await exportWorkspace(testEnv.DB, 'owner_window', 'workspace_window');
    expect(exported.content.revisions?.map((revision) => revision.revision)).toEqual([2, 3]);
  });

  it('rejects a source whose stored immutable hash no longer matches its text', async () => {
    await seedWorkspace({ ownerId: 'owner_hash', workspaceId: 'workspace_hash', snapshot: emptySnapshot() });
    await seedSource({ workspaceId: 'workspace_hash', sourceId: 'src_hash', revision: 1, title: 'Source', text: 'Original source.' });
    await testEnv.DB.prepare('UPDATE sources SET hash = ? WHERE id = ?').bind('0'.repeat(64), 'src_hash').run();
    await expect(exportWorkspace(testEnv.DB, 'owner_hash', 'workspace_hash')).rejects.toMatchObject({ code: 'EXPORT_UNAVAILABLE', status: 500 });
  });

  it('exports active owned workspace metadata, immutable sources and current committed snapshot with checksum', async () => {
    const snapshot = protectedSnapshot('src_1');
    await seedWorkspace({ ownerId: 'owner_export', workspaceId: 'workspace_export', snapshot });
    await seedSource({ workspaceId: 'workspace_export', sourceId: 'src_1', revision: 1, title: 'Original', text: 'Day 02 dinner remains 19:00.' });
    await seedSource({ workspaceId: 'workspace_export', sourceId: 'src_2', revision: 2, title: 'Update', text: 'Participants changed from four to three.' });

    const exported = await exportWorkspace(testEnv.DB, 'owner_export', 'workspace_export');

    expect(workspaceExportSchema.parse(exported)).toEqual(exported);
    expect(exported).toMatchObject({
      format: 'ieojim.workspace',
      version: 1,
      content: {
        workspace: {
          id: 'workspace_export',
          title: 'Exported workspace',
          purpose: 'Plan trip',
          revision: 3,
          sourceRevision: 2,
          createdAt,
          updatedAt,
          expiresAt,
        },
        snapshot,
      },
    });
    expect(exported.content.sources.map((source) => source.id)).toEqual(['src_1', 'src_2']);
    expect(exported.content.revisions).toEqual([{ revision: 3, reason: 'manual_edit', createdAt, snapshot }]);
    expect(exported.checksum.value).toBe(await sha256Hex(JSON.stringify(exported.content)));
    expect(exported.content.snapshot.blocks[0].items[0]).toMatchObject({ locked: true, completed: true, edited: true, stale: false });
  });

  it('does not expose owner, account, ledger, pending, provenance or command response fields', async () => {
    await seedWorkspace({ ownerId: 'owner_private', workspaceId: 'workspace_private', snapshot: protectedSnapshot('src_private'), pending: true });
    await seedSource({ workspaceId: 'workspace_private', sourceId: 'src_private', revision: 1, title: 'Private source', text: 'Day 02 dinner remains 19:00.' });
    await seedRunAndLedger('owner_private', 'workspace_private', 'src_private');
    await testEnv.DB.prepare(
      'INSERT INTO applied_commands (id, owner_id, workspace_id, request_id, command_type, payload_hash, response_json, created_at) VALUES ("cmd_private", ?, ?, ?, "manual_edit", "payload", ?, ?)',
    ).bind('owner_private', 'workspace_private', crypto.randomUUID(), '{"private":"command body"}', createdAt).run();

    const exported = await exportWorkspace(testEnv.DB, 'owner_private', 'workspace_private');
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain('owner_private');
    expect(serialized).not.toContain('account_id');
    expect(serialized).not.toContain('pending_changeset');
    expect(serialized).not.toContain('provenance');
    expect(serialized).not.toContain('ledger_private');
    expect(serialized).not.toContain('command body');
    expect(Object.keys(exported.content)).toEqual(['workspace', 'sources', 'snapshot', 'revisions']);
  });

  it('does not modify expiry or ledger state while exporting', async () => {
    await seedWorkspace({ ownerId: 'owner_readonly', workspaceId: 'workspace_readonly', snapshot: emptySnapshot() });
    await seedSource({ workspaceId: 'workspace_readonly', sourceId: 'src_readonly', revision: 1, title: 'Readonly', text: 'Readonly source.' });
    await seedRunAndLedger('owner_readonly', 'workspace_readonly', 'src_readonly');
    const before = await readExportSideEffects('workspace_readonly');

    await exportWorkspace(testEnv.DB, 'owner_readonly', 'workspace_readonly');

    expect(await readExportSideEffects('workspace_readonly')).toEqual(before);
  });

  it.each([
    ['foreign', 'owner_b', null],
    ['expired', 'owner_scope', '2000-01-01T00:00:00.000Z'],
    ['deleted', 'owner_scope', expiresAt],
  ])('returns 404 for %s workspace exports', async (_case, ownerId, workspaceExpiresAt) => {
    await seedWorkspace({
      ownerId: 'owner_scope',
      workspaceId: `workspace_${_case}`,
      snapshot: emptySnapshot(),
      expiresAt: workspaceExpiresAt ?? expiresAt,
      deletedAt: _case === 'deleted' ? createdAt : null,
    });

    await expect(exportWorkspace(testEnv.DB, ownerId, `workspace_${_case}`))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND', status: 404 });
  });

  it.each(['missing-source', 'out-of-range', 'quote-mismatch'])('rejects corrupted evidence linkage: %s', async (fault) => {
    const snapshot = protectedSnapshot('src_evidence');
    if (fault === 'missing-source') snapshot.facts[0].evidence.sourceId = 'missing';
    if (fault === 'out-of-range') snapshot.facts[0].evidence.end += 1;
    if (fault === 'quote-mismatch') snapshot.facts[0].evidence.quote = 'A different quote';
    await seedWorkspace({ ownerId: 'owner_evidence', workspaceId: 'workspace_evidence', snapshot });
    await seedSource({ workspaceId: 'workspace_evidence', sourceId: 'src_evidence', revision: 1, title: 'Evidence', text: 'Day 02 dinner remains 19:00.' });
    await expect(exportWorkspace(testEnv.DB, 'owner_evidence', 'workspace_evidence')).rejects.toMatchObject({ code: 'EXPORT_UNAVAILABLE', status: 500 });
  });

  it('bounds the complete envelope including metadata and checksum to two MiB', async () => {
    await seedWorkspace({ ownerId: 'owner_size', workspaceId: 'workspace_size', snapshot: emptySnapshot() });
    const first = await exportWorkspace(testEnv.DB, 'owner_size', 'workspace_size');
    const baseBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    const title = first.content.workspace.title + 'a'.repeat(MAX_EXPORT_BYTES - baseBytes);
    await testEnv.DB.prepare('UPDATE workspaces SET title=? WHERE id=?').bind(title, 'workspace_size').run();
    const exact = await exportWorkspace(testEnv.DB, 'owner_size', 'workspace_size');
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(MAX_EXPORT_BYTES);
    await testEnv.DB.prepare('UPDATE workspaces SET title=? WHERE id=?').bind(title + 'a', 'workspace_size').run();
    await expect(exportWorkspace(testEnv.DB, 'owner_size', 'workspace_size')).rejects.toMatchObject({ code: 'WORKSPACE_EXPORT_TOO_LARGE', status: 413 });
  });

  it('fails closed when the current snapshot row is missing', async () => {
    await seedWorkspace({ ownerId: 'owner_missing', workspaceId: 'workspace_missing', snapshot: emptySnapshot() });
    await testEnv.DB.prepare('DELETE FROM snapshots WHERE workspace_id = ?').bind('workspace_missing').run();

    await expect(exportWorkspace(testEnv.DB, 'owner_missing', 'workspace_missing'))
      .rejects.toMatchObject({ code: 'EXPORT_UNAVAILABLE', status: 500 });
  });

  it('fails closed when the current snapshot is corrupt', async () => {
    await seedWorkspace({ ownerId: 'owner_corrupt', workspaceId: 'workspace_corrupt', snapshot: emptySnapshot() });
    await testEnv.DB.prepare('UPDATE snapshots SET snapshot_json = ? WHERE workspace_id = ?').bind('{"blocks":[]}', 'workspace_corrupt').run();

    await expect(exportWorkspace(testEnv.DB, 'owner_corrupt', 'workspace_corrupt'))
      .rejects.toMatchObject({ code: 'EXPORT_UNAVAILABLE', status: 500 });
  });
});

async function seedWorkspace(options: {
  ownerId: string;
  workspaceId: string;
  snapshot: Snapshot;
  expiresAt?: string;
  deletedAt?: string | null;
  pending?: boolean;
}) {
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .bind(options.ownerId, `${options.ownerId}_token`, createdAt, createdAt),
    testEnv.DB.prepare(
      `INSERT INTO workspaces (id, owner_id, title, purpose, revision, source_revision, current_snapshot_revision, pending_changeset_json, pending_proposal_revision, created_at, updated_at, expires_at, deleted_at)
       VALUES (?, ?, "Exported workspace", "Plan trip", 3, 2, 3, ?, 1, ?, ?, ?, ?)`,
    ).bind(options.workspaceId, options.ownerId, options.pending ? '{"id":"pending_private"}' : null, createdAt, updatedAt, options.expiresAt ?? expiresAt, options.deletedAt ?? null),
    testEnv.DB.prepare('INSERT INTO snapshots (workspace_id, revision, snapshot_json, reason, created_at) VALUES (?, 3, ?, "manual_edit", ?)')
      .bind(options.workspaceId, JSON.stringify(options.snapshot), createdAt),
  ]);
}

async function seedSource(options: { workspaceId: string; sourceId: string; revision: number; title: string; text: string }) {
  await testEnv.DB.prepare(
    'INSERT INTO sources (id, workspace_id, source_revision, title, relation, target_source_id, hash, text, created_at) VALUES (?, ?, ?, ?, "initial", NULL, ?, ?, ?)',
  ).bind(options.sourceId, options.workspaceId, options.revision, options.title, await sha256Hex(options.text), options.text, createdAt).run();
}

async function seedRunAndLedger(ownerId: string, workspaceId: string, sourceId: string) {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      'INSERT INTO runs (id, workspace_id, owner_id, source_id, status, mode, request_id, payload_hash, base_revision, base_source_revision, reserved_micro_usd, provenance_json, created_at, updated_at) VALUES ("run_private", ?, ?, ?, "ready", "live", ?, "payload", 3, 2, 100, ?, ?, ?)',
    ).bind(workspaceId, ownerId, sourceId, crypto.randomUUID(), '{"requestSha256":"private"}', createdAt, createdAt),
    testEnv.DB.prepare(
      'INSERT INTO budget_ledger (id, owner_id, workspace_id, run_id, entry_type, amount_micro_usd, created_at) VALUES ("ledger_private", ?, ?, "run_private", "reserve", 100, ?)',
    ).bind(ownerId, workspaceId, createdAt),
  ]);
}

async function readExportSideEffects(workspaceId: string) {
  return testEnv.DB.prepare(
    `SELECT
      (SELECT expires_at FROM workspaces WHERE id = ?) AS expires_at,
      (SELECT COUNT(*) FROM budget_ledger WHERE workspace_id = ?) AS ledger_count,
      (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM budget_ledger WHERE workspace_id = ?) AS ledger_amount`,
  ).bind(workspaceId, workspaceId, workspaceId).first();
}

function protectedSnapshot(sourceId: string): Snapshot {
  return {
    facts: [{
      id: 'fact_dinner',
      key: 'dinner_time',
      label: 'Dinner time',
      value: '19:00',
      evidence: { sourceId, quote: 'Day 02 dinner remains 19:00.', start: 0, end: 'Day 02 dinner remains 19:00.'.length },
      semantic: { kind: 'date_time', time: '19:00', timezone: 'Asia/Seoul' },
    }],
    blocks: [{
      id: 'block_schedule',
      key: 'schedule',
      type: 'schedule',
      title: 'Schedule',
      items: [{
        id: 'item_dinner',
        key: 'dinner',
        label: 'DAY 02 dinner',
        value: '19:00',
        factKeys: ['dinner_time'],
        valueFactKey: 'dinner_time',
        calculation: null,
        completed: true,
        locked: true,
        edited: true,
        stale: false,
      }],
    }],
  };
}
