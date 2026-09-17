/// <reference types="@cloudflare/vitest-plugin/types" />

import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../src/server/db';
import type { CorePort, SampleScenario } from '../../src/server/core-port';
import { type ChangeSet, type ProposalDraft, type Snapshot } from '../../src/core/contracts';

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1]; GEMINI_API_KEY?: string };

const testEnv = env as TestEnv;

const core: CorePort = {
  buildChangeSet({ snapshot, draft, baseRevision, baseSourceRevision, id, now }) {
    const next: Snapshot = {
      facts: draft.facts.map((fact, index) => ({
        id: `fact_${fact.key}_${index}`,
        key: fact.key,
        label: fact.label,
        value: fact.value,
        evidence: { sourceId: fact.sourceId, quote: fact.quote, start: 0, end: fact.quote.length },
      })),
      blocks: draft.blocks.map((block, blockIndex) => ({
        id: snapshot.blocks.find((candidate) => candidate.key === block.key)?.id ?? `block_${blockIndex}`,
        key: block.key,
        type: block.type,
        title: block.title,
        items: block.items.map((item, itemIndex) => {
          const existing = snapshot.blocks.flatMap((candidate) => candidate.items).find((candidate) => candidate.key === item.key);
          return {
            id: existing?.id ?? `item_${item.key}_${itemIndex}`,
            key: item.key,
            label: item.label,
            value: item.value,
            factKeys: item.factKeys,
            valueFactKey: item.valueFactKey,
            calculation: item.calculation,
            completed: existing?.completed ?? false,
            locked: existing?.locked ?? false,
            edited: existing?.edited ?? false,
            stale: false,
          };
        }),
      })),
    };
    return {
      id: id ?? 'cs_account_quota',
      baseRevision,
      baseSourceRevision,
      proposalRevision: 1,
      summary: draft.summary,
      questions: draft.questions,
      changes: [],
      conflicts: [],
      next,
      createdAt: now ?? new Date(0).toISOString(),
    };
  },
  resolveChangeSet(changeSet: ChangeSet) {
    return changeSet.next;
  },
  editItem(snapshot) {
    return snapshot;
  },
};

const sampleDraft = (sourceId: string): ProposalDraft => ({
  summary: 'sample',
  questions: [],
  facts: [{ key: 'participant_count', label: 'participants', value: 4, sourceId, quote: '4 people' }],
  blocks: [{
    key: 'note',
    type: 'note',
    title: 'Plan',
    items: [{ key: 'memo', label: 'Memo', value: 'Keep decisions', factKeys: [], valueFactKey: null, calculation: null }],
  }],
  removedItems: [],
});

const scenario: SampleScenario = {
  title: 'Travel sample',
  purpose: 'Plan trip',
  initialText: '4 people travel.',
  updateText: '3 people travel.',
  conflictText: 'conflict with locked item.',
  initialDraft: sampleDraft,
  updateDraft: sampleDraft,
  conflictDraft: sampleDraft,
};

beforeEach(async () => {
  vi.restoreAllMocks();
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('account owner quota buckets', () => {
  it('enforces the active workspace cap across owner buckets for the same account', async () => {
    await seedAccountOwner('own_account_a', 'acct_shared');
    await seedAccountOwner('own_account_b', 'acct_shared');
    const store = new WorkspaceStore(testEnv);

    for (let index = 0; index < 5; index += 1) {
      await store.createWorkspace('own_account_a', `A ${index}`, 'quota');
      await store.createWorkspace('own_account_b', `B ${index}`, 'quota');
    }

    await expect(store.createWorkspace('own_account_a', 'A over', 'quota')).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' });
    await expect(store.createSample('own_account_b', 'travel', scenario, core)).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' });
  });

  it('keeps guest workspace caps isolated by owner id', async () => {
    await seedGuestOwner('own_guest_a');
    await seedGuestOwner('own_guest_b');
    const store = new WorkspaceStore(testEnv);

    for (let index = 0; index < 10; index += 1) {
      await store.createWorkspace('own_guest_a', `A ${index}`, 'quota');
    }

    await expect(store.createWorkspace('own_guest_a', 'A over', 'quota')).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' });
    await expect(store.createWorkspace('own_guest_b', 'B first', 'quota')).resolves.toMatchObject({ title: 'B first' });
  });

  it('aggregates live reservations and retry reservations across owner buckets without rewriting ledger owners', async () => {
    await seedAccountOwner('own_live_a', 'acct_live');
    await seedAccountOwner('own_live_b', 'acct_live');
    const store = new WorkspaceStore({ ...testEnv, GEMINI_API_KEY: 'test-key', OWNER_DAILY_RUNS: '2' } as unknown as ConstructorParameters<typeof WorkspaceStore>[0]);
    const enqueue = async (_runId: string): Promise<void> => {};
    const a = await store.createWorkspace('own_live_a', 'A', 'quota');
    const b = await store.createWorkspace('own_live_b', 'B', 'quota');

    await store.addSource('own_live_a', a.id, sourceInput('a first'), enqueue);
    const bSource = await store.addSource('own_live_b', b.id, sourceInput('b first'), enqueue);

    await expect(store.addSource('own_live_a', a.id, sourceInput('a over', 'addition'), enqueue)).rejects.toMatchObject({ code: 'OWNER_DAILY_RUN_LIMIT' });

    const run = bSource.runs[0];
    await testEnv.DB.prepare('UPDATE runs SET status = "failed", error = "retryable" WHERE id = ?').bind(run.id).run();
    await expect(store.retryRun('own_live_b', b.id, run.id, crypto.randomUUID(), enqueue)).rejects.toMatchObject({ code: 'OWNER_DAILY_RUN_LIMIT' });

    const ledgerOwners = await testEnv.DB.prepare('SELECT owner_id, COUNT(*) AS count FROM budget_ledger WHERE entry_type = "reserve" GROUP BY owner_id ORDER BY owner_id')
      .all<{ owner_id: string; count: number }>();
    expect(ledgerOwners.results).toEqual([
      { owner_id: 'own_live_a', count: 1 },
      { owner_id: 'own_live_b', count: 1 },
    ]);
  });
});

const seedAccountOwner = async (ownerId: string, accountId: string) => {
  const now = new Date().toISOString();
  await testEnv.DB.prepare('INSERT INTO app_accounts (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(accountId, now)
    .run();
  await testEnv.DB.prepare('INSERT INTO owners (id, token_hash, account_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ownerId, `${ownerId}_hash`, accountId, now, now)
    .run();
};

const seedGuestOwner = async (ownerId: string) => {
  const now = new Date().toISOString();
  await testEnv.DB.prepare('INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .bind(ownerId, `${ownerId}_hash`, now, now)
    .run();
};

const sourceInput = (text: string, relation: 'initial' | 'addition' = 'initial') => ({
  title: text,
  text,
  relation,
  targetSourceId: null,
  requestId: crypto.randomUUID(),
});
