import { z } from 'zod';
import {
  type Block,
  type BlockItem,
  type Change,
  type ChangeSet,
  type Conflict,
  DomainError,
  type Evidence,
  type FactSemantic,
  type LiveProposalDraftV2,
  LIMITS,
  type ProposalDraft,
  type Resolution,
  type Snapshot,
  type Source,
  legacyDraftSchema,
  editItemSchema,
  liveDraftV2Schema,
  snapshotSchema,
} from './contracts';
import { assertFactSemanticConsistency, assertNoTargetedFactIdentityCollision, assertNumericEvidenceConsistency, inferFactSemanticForCalculation, normalizeFactLabel } from './proposal-safety';

type BuildChangeSetInput = {
  snapshot: Snapshot;
  sources: Source[];
  draft: ProposalDraft | LiveProposalDraftV2;
  baseRevision: number;
  baseSourceRevision: number;
  id?: string;
  now?: string;
};

type IndexedSnapshot = {
  factsByKey: Map<string, Snapshot['facts'][number]>;
  blocksByKey: Map<string, Block>;
  itemsById: Map<string, { block: Block; item: BlockItem }>;
  itemsByStableId: Map<string, BlockItem>;
};

type NormalizedDraftFact = {
  key: string; label: string; value: string | number; sourceId: string; quote: string;
  operation: 'create' | 'update' | null; targetFactKey: string | null; semantic: FactSemantic | null | undefined;
};
type NormalizedDraftItem = {
  key: string; label: string; value: string; factKeys: string[]; valueFactKey: string | null; calculation: BlockItem['calculation'];
  operation: 'create' | 'update' | null; targetItemId: string | null;
};
type NormalizedDraft = {
  schemaVersion: 1 | 2;
  summary: string;
  questions: string[];
  facts: NormalizedDraftFact[];
  blocks: Array<{ key: string; type: Block['type']; title: string; items: NormalizedDraftItem[] }>;
  removedItems: Array<{ itemId: string; sourceId: string; quote: string }>;
};

const idForFact = (key: string) => `fact:${key}`;
const idForBlock = (key: string) => `block:${key}`;
const idForItem = (blockKey: string, itemKey: string) => `item:${blockKey}:${itemKey}`;
const conflictId = (kind: Conflict['kind'], id: string, factKey: string | null = null) =>
  `conflict:${kind}:${id}:${factKey ?? 'none'}`;
const changeId = (targetId: string, reason: string) => `change:${targetId}:${reason}`;

const cloneSnapshot = (snapshot: Snapshot): Snapshot => snapshotSchema.parse(structuredClone(snapshot));

const normalizeValue = (value: string | number) => (typeof value === 'number' ? String(value) : value);

const sameValue = (left: string | number, right: string | number) => normalizeValue(left) === normalizeValue(right);

const sameSemantic = (left: FactSemantic | null | undefined, right: FactSemantic | null | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const parseDraft = (draft: ProposalDraft): NormalizedDraft => {
  const raw = draft as { schemaVersion?: unknown };
  if (raw.schemaVersion === 2) {
    const parsed = liveDraftV2Schema.parse(draft);
    return {
      schemaVersion: 2,
      summary: parsed.summary,
      questions: parsed.questions,
      facts: parsed.facts.map((fact) => ({ ...fact })),
      blocks: parsed.blocks.map((block) => ({ ...block, items: block.items.map((item) => ({ ...item })) })),
      removedItems: parsed.removedItems.map((removal) => ({ itemId: removal.itemId, sourceId: removal.sourceId, quote: removal.quote })),
    };
  }
  const parsed = legacyDraftSchema.parse(draft);
  return {
    schemaVersion: 1,
    summary: parsed.summary,
    questions: parsed.questions,
    facts: parsed.facts.map((fact) => ({ ...fact, operation: null, targetFactKey: null, semantic: undefined })),
    blocks: parsed.blocks.map((block) => ({
      ...block,
      items: block.items.map((item) => ({ ...item, operation: null, targetItemId: null })),
    })),
    removedItems: parsed.removedItems,
  };
};

const indexSnapshot = (snapshot: Snapshot): IndexedSnapshot => {
  const factsByKey = new Map(snapshot.facts.map((fact) => [fact.key, fact]));
  const blocksByKey = new Map(snapshot.blocks.map((block) => [block.key, block]));
  const itemsById = new Map<string, { block: Block; item: BlockItem }>();
  const itemsByStableId = new Map<string, BlockItem>();

  for (const block of snapshot.blocks) {
    for (const item of block.items) {
      itemsById.set(item.id, { block, item });
      itemsByStableId.set(idForItem(block.key, item.key), item);
    }
  }

  return { factsByKey, blocksByKey, itemsById, itemsByStableId };
};

const findSource = (sources: Source[], id: string): Source => {
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) throw new DomainError('BAD_EVIDENCE_SOURCE', `Unknown source: ${id}`);
  return source;
};

const locateEvidence = (sources: Source[], sourceId: string, quote: string): Evidence => {
  const source = findSource(sources, sourceId);
  const start = source.text.indexOf(quote);
  if (start < 0) {
    throw new DomainError('BAD_EVIDENCE_QUOTE', `Quote was not found in source ${sourceId}`);
  }
  return { sourceId, quote, start, end: start + quote.length };
};

const assertEvidenceStillMatches = (sources: Source[], evidence: Evidence): void => {
  const source = findSource(sources, evidence.sourceId);
  if (evidence.start >= evidence.end || evidence.end > source.text.length) {
    throw new DomainError('BAD_EVIDENCE_RANGE', `Evidence range is outside source ${evidence.sourceId}`);
  }
  const actual = source.text.slice(evidence.start, evidence.end);
  if (actual !== evidence.quote) {
    throw new DomainError('BAD_EVIDENCE_RANGE', `Evidence range does not match quote for source ${evidence.sourceId}`);
  }
};

const formatCalculatedValue = (value: number): string => {
  if (!Number.isFinite(value)) throw new DomainError('INVALID_CALCULATION', 'Calculation did not produce a finite value');
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
};

const numericFact = (factsByKey: Map<string, Snapshot['facts'][number]>, key: string): number => {
  const fact = factsByKey.get(key);
  if (!fact || typeof fact.value !== 'number' || !Number.isFinite(fact.value)) {
    throw new DomainError('INVALID_CALCULATION', `Calculation requires numeric fact ${key}`);
  }
  return fact.value;
};

const calculationSemantic = (fact: Snapshot['facts'][number] | undefined, role: 'total' | 'divisor', allowInference: boolean): FactSemantic | null => {
  if (!fact) return null;
  return fact.semantic ?? (allowInference ? inferFactSemanticForCalculation({ value: fact.value, quote: fact.evidence.quote }, role) : null);
};

const assertCalculationSemantics = (item: Pick<BlockItem, 'calculation'>, factsByKey: Map<string, Snapshot['facts'][number]>): void => {
  if (!item.calculation) return;
  const total = factsByKey.get(item.calculation.totalFactKey);
  const divisor = factsByKey.get(item.calculation.divisorFactKey);
  const hasExplicitSemantic = Boolean(total?.semantic || divisor?.semantic);
  const totalSemantic = calculationSemantic(total, 'total', hasExplicitSemantic);
  const divisorSemantic = calculationSemantic(divisor, 'divisor', hasExplicitSemantic);
  if (!hasExplicitSemantic) return;
  if (totalSemantic?.kind !== 'money' || totalSemantic.unit !== 'KRW' || divisorSemantic?.kind !== 'count') {
    throw new DomainError('INVALID_CALCULATION_SEMANTICS', 'Typed calculations require KRW money divided by a count fact');
  }
};

const computeItemValue = (item: Pick<BlockItem, 'calculation' | 'value'>, factsByKey: Map<string, Snapshot['facts'][number]>): string => {
  if (!item.calculation) return item.value;
  assertCalculationSemantics(item, factsByKey);
  const total = numericFact(factsByKey, item.calculation.totalFactKey);
  const divisor = numericFact(factsByKey, item.calculation.divisorFactKey);
  if (divisor <= 0) throw new DomainError('INVALID_CALCULATION', 'Division requires a positive denominator');
  return formatCalculatedValue(total / divisor);
};

const pushChange = (changes: Change[], change: Change): void => {
  if (!changes.some((existing) => existing.id === change.id)) changes.push(change);
};

const pushConflict = (conflicts: Conflict[], conflict: Conflict): void => {
  if (!conflicts.some((existing) => existing.id === conflict.id)) conflicts.push(conflict);
};

const shouldTreatFactAsContradictoryAddition = (source: Source) => source.relation === 'addition';

const enforceSnapshotLimits = (snapshot: Snapshot): void => {
  const itemCount = snapshot.blocks.reduce((sum, block) => sum + block.items.length, 0);
  if (snapshot.facts.length > LIMITS.maxFacts) throw new DomainError('LIMIT_EXCEEDED', 'Too many facts in snapshot');
  if (snapshot.blocks.length > LIMITS.maxBlocks) throw new DomainError('LIMIT_EXCEEDED', 'Too many blocks in snapshot');
  if (itemCount > LIMITS.maxItems) throw new DomainError('LIMIT_EXCEEDED', 'Too many items in snapshot');
};

const itemEvidence = (item: BlockItem, factsByKey: Map<string, Snapshot['facts'][number]>): Evidence[] =>
  item.factKeys.flatMap((key) => {
    const fact = factsByKey.get(key);
    return fact ? [fact.evidence] : [];
  });

const intersects = (values: string[], keys: Set<string>) => values.some((value) => keys.has(value));

const hasMeaningfulPreparation = (item: Pick<BlockItem, 'preparation'>): boolean =>
  Boolean(item.preparation && (item.preparation.dueDate !== null || item.preparation.durationMinutes !== null));

const preservePreparation = (target: BlockItem, source: Pick<BlockItem, 'preparation'>): void => {
  if (source.preparation) target.preparation = source.preparation;
  else delete target.preparation;
};

const assertUnique = (values: string[], code: string, label: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new DomainError(code, `Duplicate ${label}: ${value}`);
    seen.add(value);
  }
};

const validateDraftIdentity = (draft: NormalizedDraft): void => {
  assertUnique(
    draft.facts.map((fact) => fact.key),
    'DUPLICATE_FACT_KEY',
    'fact key',
  );
  assertUnique(
    draft.blocks.map((block) => block.key),
    'DUPLICATE_BLOCK_KEY',
    'block key',
  );
  const globalItemIds: string[] = [];
  for (const block of draft.blocks) {
    assertUnique(
      block.items.map((item) => item.key),
      'DUPLICATE_ITEM_KEY',
      `item key in block ${block.key}`,
    );
    globalItemIds.push(...block.items.map((item) => idForItem(block.key, item.key)));
  }
  assertUnique(globalItemIds, 'DUPLICATE_ITEM_ID', 'item identity');
  const updatedItemIds = new Set(globalItemIds);
  for (const removal of draft.removedItems) {
    if (updatedItemIds.has(removal.itemId)) {
      throw new DomainError('CONTRADICTORY_DRAFT_ITEM', `Item ${removal.itemId} is both updated and removed`);
    }
  }
};

const assertLiveDraftTargets = (draft: NormalizedDraft, snapshot: Snapshot): void => {
  if (draft.schemaVersion !== 2) return;
  const currentIndex = indexSnapshot(snapshot);
  const currentFactKeys = new Set(snapshot.facts.map((fact) => fact.key));

  for (const fact of draft.facts) {
    if (fact.operation === 'create') {
      if (fact.targetFactKey !== null) throw new DomainError('BAD_FACT_OPERATION_TARGET', `Created fact ${fact.key} must not target an existing fact`);
      if (currentFactKeys.has(fact.key)) throw new DomainError('BAD_FACT_OPERATION_TARGET', `Existing fact ${fact.key} must be updated explicitly`);
      continue;
    }
    if (fact.operation !== 'update' || fact.targetFactKey === null) throw new DomainError('BAD_FACT_OPERATION_TARGET', `Fact ${fact.key} requires an explicit operation target`);
    if (fact.key !== fact.targetFactKey) throw new DomainError('BAD_FACT_OPERATION_TARGET', `Fact ${fact.key} cannot update target ${fact.targetFactKey}`);
    if (!currentFactKeys.has(fact.targetFactKey)) throw new DomainError('BAD_FACT_OPERATION_TARGET', `Fact update target ${fact.targetFactKey} does not exist`);
  }

  for (const block of draft.blocks) {
    const currentBlock = snapshot.blocks.find((candidate) => candidate.key === block.key);
    const existingItemsByLabel = new Map((currentBlock?.items ?? []).map((item) => [normalizeFactLabel(item.label), item.id]));
    for (const item of block.items) {
      const stableId = idForItem(block.key, item.key);
      if (item.operation === 'create') {
        if (item.targetItemId !== null) throw new DomainError('BAD_ITEM_OPERATION_TARGET', `Created item ${stableId} must not target an existing item`);
        if (currentIndex.itemsById.has(stableId)) throw new DomainError('BAD_ITEM_OPERATION_TARGET', `Existing item ${stableId} must be updated explicitly`);
        const sameLabel = existingItemsByLabel.get(normalizeFactLabel(item.label));
        if (sameLabel) throw new DomainError('ITEM_IDENTITY_COLLISION', `Item ${stableId} appears to duplicate existing item ${sameLabel}`);
        continue;
      }
      if (item.operation !== 'update' || item.targetItemId === null) throw new DomainError('BAD_ITEM_OPERATION_TARGET', `Item ${stableId} requires an explicit operation target`);
      if (item.targetItemId !== stableId) throw new DomainError('BAD_ITEM_OPERATION_TARGET', `Item ${stableId} cannot update target ${item.targetItemId}`);
      if (!currentIndex.itemsById.has(item.targetItemId)) throw new DomainError('BAD_ITEM_OPERATION_TARGET', `Item update target ${item.targetItemId} does not exist`);
    }
  }

  const removals = new Set<string>();
  for (const removal of draft.removedItems) {
    if (removals.has(removal.itemId)) throw new DomainError('DUPLICATE_ITEM_REMOVAL', `Duplicate removal target: ${removal.itemId}`);
    removals.add(removal.itemId);
    if (!currentIndex.itemsById.has(removal.itemId)) throw new DomainError('BAD_ITEM_OPERATION_TARGET', `Removal target ${removal.itemId} does not exist`);
  }
};

const validateSnapshotIdentity = (snapshot: Snapshot): void => {
  assertUnique(
    snapshot.facts.map((fact) => fact.id),
    'DUPLICATE_FACT_ID',
    'fact id',
  );
  assertUnique(
    snapshot.facts.map((fact) => fact.key),
    'DUPLICATE_FACT_KEY',
    'fact key',
  );
  assertUnique(
    snapshot.blocks.map((block) => block.id),
    'DUPLICATE_BLOCK_ID',
    'block id',
  );
  assertUnique(
    snapshot.blocks.map((block) => block.key),
    'DUPLICATE_BLOCK_KEY',
    'block key',
  );
  const itemIds: string[] = [];
  const stableItemIds: string[] = [];
  for (const block of snapshot.blocks) {
    assertUnique(
      block.items.map((item) => item.key),
      'DUPLICATE_ITEM_KEY',
      `item key in block ${block.key}`,
    );
    for (const item of block.items) {
      const stableId = idForItem(block.key, item.key);
      if (item.id !== stableId) throw new DomainError('ITEM_ID_MISMATCH', `Item ${item.id} does not match ${stableId}`);
      itemIds.push(item.id);
      stableItemIds.push(stableId);
    }
  }
  assertUnique(itemIds, 'DUPLICATE_ITEM_ID', 'item id');
  assertUnique(stableItemIds, 'DUPLICATE_ITEM_ID', 'item identity');
};

const validateSourceRelations = (sources: Source[]): void => {
  const sourceIds = new Set(sources.map((source) => source.id));
  assertUnique(
    sources.map((source) => source.id),
    'DUPLICATE_SOURCE_ID',
    'source id',
  );
  for (const source of sources) {
    if (source.relation === 'correction' || source.relation === 'replacement') {
      if (!source.targetSourceId || !sourceIds.has(source.targetSourceId)) {
        throw new DomainError('BAD_SOURCE_RELATION', `${source.relation} source ${source.id} must target an existing source`);
      }
    }
  }
};

const recalculateDerivedItems = (snapshot: Snapshot): void => {
  const factsByKey = new Map(snapshot.facts.map((fact) => [fact.key, fact]));
  for (const block of snapshot.blocks) {
    for (const item of block.items) {
      if (item.locked || item.edited) continue;
      const calculated = computeItemValue(item, factsByKey);
      if (item.completed && item.value !== calculated) item.stale = true;
      item.value = calculated;
    }
  }
};

export const buildChangeSet = (input: BuildChangeSetInput): ChangeSet => {
  if (input.baseRevision < 0 || input.baseSourceRevision < 0) {
    throw new DomainError('BAD_REVISION', 'Base revisions must be non-negative');
  }

  const current = cloneSnapshot(input.snapshot);
  validateSnapshotIdentity(current);
  const parsedDraft = parseDraft(input.draft);
  validateDraftIdentity(parsedDraft);
  validateSourceRelations(input.sources);
  for (const fact of current.facts) assertEvidenceStillMatches(input.sources, fact.evidence);
  assertLiveDraftTargets(parsedDraft, current);

  const changes: Change[] = [];
  const conflicts: Conflict[] = [];
  const next = cloneSnapshot(current);
  const currentIndex = indexSnapshot(current);
  const nextFactsByKey = new Map(next.facts.map((fact) => [fact.key, fact]));
  const changedFactKeys = new Set<string>();
  const sourceConflictedFactKeys = new Set<string>();
  const processedItemIds = new Set<string>();
  const removalItemIds = new Set(parsedDraft.removedItems.map((removal) => removal.itemId));

  for (const draftFact of parsedDraft.facts) {
    const evidence = locateEvidence(input.sources, draftFact.sourceId, draftFact.quote);
    assertNumericEvidenceConsistency(draftFact);
    assertFactSemanticConsistency(draftFact, parsedDraft.schemaVersion === 2);
    assertNoTargetedFactIdentityCollision(current, input.sources, draftFact);
    const source = findSource(input.sources, draftFact.sourceId);
    const existing = nextFactsByKey.get(draftFact.key);
    const after = draftFact.value;

    if (existing) {
      const semanticChanged = draftFact.semantic !== undefined && !sameSemantic(existing.semantic, draftFact.semantic);
      if (existing.semantic && draftFact.semantic === null) throw new DomainError('SEMANTIC_ERASURE', `Typed fact ${existing.key} cannot erase semantic metadata`);
      if (
        !existing.semantic &&
        draftFact.semantic &&
        sameValue(existing.value, after) &&
        draftFact.sourceId === existing.evidence.sourceId &&
        draftFact.quote === existing.evidence.quote
      ) {
        existing.semantic = draftFact.semantic;
        continue;
      }
      if (!sameValue(existing.value, after) || semanticChanged) {
        const validTargetedChange =
          (source.relation === 'correction' || source.relation === 'replacement') && source.targetSourceId === existing.evidence.sourceId;
        const contradictoryAddition = shouldTreatFactAsContradictoryAddition(source);
        if (contradictoryAddition) {
          pushConflict(conflicts, {
            id: conflictId('source', existing.id, existing.key),
            itemId: null,
            kind: 'source',
            factKey: existing.key,
            message: `${existing.label} has competing source observations.`,
          });
          pushChange(changes, {
            id: changeId(existing.id, 'source-conflict'),
            targetId: existing.id,
            label: existing.label,
            before: normalizeValue(existing.value),
            after: normalizeValue(after),
            status: 'needs_review',
            reason: 'A new source contradicts the current fact and must be resolved explicitly.',
            evidence: [evidence],
            beforeSemantic: existing.semantic ?? null,
            afterSemantic: draftFact.semantic ?? null,
          });
          sourceConflictedFactKeys.add(existing.key);
          continue;
        }
        if (!validTargetedChange) {
          throw new DomainError(
            'BAD_SOURCE_RELATION',
            `Changing fact ${existing.key} requires a correction or replacement targeting ${existing.evidence.sourceId}`,
          );
        }

        pushChange(changes, {
          id: changeId(existing.id, 'fact'),
          targetId: existing.id,
          label: existing.label,
          before: normalizeValue(existing.value),
          after: normalizeValue(after),
          status: 'changed',
          reason: 'Source-backed fact changed.',
          evidence: [evidence],
          beforeSemantic: existing.semantic ?? null,
          afterSemantic: draftFact.semantic ?? null,
        });
        changedFactKeys.add(existing.key);
      }
      existing.label = draftFact.label;
      existing.value = after;
      existing.evidence = evidence;
      if (draftFact.semantic !== undefined) existing.semantic = draftFact.semantic;
    } else {
      const fact = { id: idForFact(draftFact.key), key: draftFact.key, label: draftFact.label, value: after, evidence, ...(draftFact.semantic !== undefined ? { semantic: draftFact.semantic } : {}) };
      next.facts.push(fact);
      nextFactsByKey.set(fact.key, fact);
      pushChange(changes, {
        id: changeId(fact.id, 'fact-added'),
        targetId: fact.id,
        label: fact.label,
        before: '',
        after: normalizeValue(fact.value),
        status: 'changed',
        reason: 'New source-backed fact was added.',
        evidence: [fact.evidence],
        afterSemantic: fact.semantic ?? null,
      });
    }
  }

  const nextIndex = indexSnapshot(next);
  const nextBlocksByKey = new Map(next.blocks.map((block) => [block.key, block]));

  for (const draftBlock of parsedDraft.blocks) {
    let block = nextBlocksByKey.get(draftBlock.key);
    if (block && block.type !== draftBlock.type) {
      throw new DomainError('BLOCK_TYPE_CHANGED', `Block ${draftBlock.key} cannot change type`);
    }
    if (!block) {
      block = { id: idForBlock(draftBlock.key), key: draftBlock.key, type: draftBlock.type, title: draftBlock.title, items: [] };
      next.blocks.push(block);
      nextBlocksByKey.set(block.key, block);
    } else {
      block.title = draftBlock.title;
    }

    for (const draftItem of draftBlock.items) {
      for (const factKey of draftItem.factKeys) {
        if (!nextFactsByKey.has(factKey)) throw new DomainError('UNKNOWN_FACT_REFERENCE', `Item references unknown fact ${factKey}`);
      }
      if (draftItem.valueFactKey && !nextFactsByKey.has(draftItem.valueFactKey)) {
        throw new DomainError('UNKNOWN_FACT_REFERENCE', `Item value references unknown fact ${draftItem.valueFactKey}`);
      }
      if (draftItem.valueFactKey && !draftItem.factKeys.includes(draftItem.valueFactKey)) {
        throw new DomainError('INCONSISTENT_FACT_REFERENCE', `Item value fact ${draftItem.valueFactKey} must be included in factKeys`);
      }
      if (
        draftItem.calculation &&
        (!draftItem.factKeys.includes(draftItem.calculation.totalFactKey) || !draftItem.factKeys.includes(draftItem.calculation.divisorFactKey))
      ) {
        throw new DomainError('INCONSISTENT_FACT_REFERENCE', 'Calculation facts must be included in factKeys');
      }
      assertCalculationSemantics(draftItem, nextFactsByKey);

      const stableId = idForItem(draftBlock.key, draftItem.key);
      processedItemIds.add(stableId);
      const existing = currentIndex.itemsByStableId.get(stableId);
      const computedValue = computeItemValue({ calculation: draftItem.calculation, value: draftItem.value }, nextFactsByKey);
      const nextExisting = block.items.find((item) => item.id === stableId);
      const evidence = itemEvidence(
        { ...draftItem, id: stableId, completed: false, locked: false, edited: false, stale: false, value: computedValue },
        nextFactsByKey,
      );

      if (existing) {
        if (existing.id !== stableId) {
          throw new DomainError('ITEM_REPARENTED', `Item ${draftItem.key} changed identity`);
        }
        const valueChanged = existing.value !== computedValue || existing.label !== draftItem.label;
        const dependenciesChanged = existing.factKeys.length !== draftItem.factKeys.length ||
          existing.factKeys.some((key) => !draftItem.factKeys.includes(key)) ||
          existing.valueFactKey !== draftItem.valueFactKey ||
          JSON.stringify(existing.calculation) !== JSON.stringify(draftItem.calculation);
        const completedNeedsReview = existing.completed && (valueChanged || dependenciesChanged ||
          intersects([...existing.factKeys, ...draftItem.factKeys], changedFactKeys));
        const protectedByUser = existing.locked || existing.edited;
        const target = nextExisting ?? existing;
        const blockedBySourceConflict = intersects(draftItem.factKeys, sourceConflictedFactKeys);

        if (blockedBySourceConflict) {
          target.label = existing.label;
          target.value = existing.value;
          target.factKeys = existing.factKeys;
          target.valueFactKey = existing.valueFactKey;
          target.calculation = existing.calculation;
          target.completed = existing.completed;
          target.locked = existing.locked;
          target.edited = existing.edited;
          target.stale = existing.stale;
          preservePreparation(target, existing);
          pushChange(changes, {
            id: changeId(existing.id, 'source-conflict-item'),
            targetId: existing.id,
            label: existing.label,
            before: existing.value,
            after: computedValue,
            status: 'needs_review',
            reason: 'This item depends on a source conflict and is preserved until the source choice is resolved.',
            evidence,
          });
          continue;
        }

        target.label = protectedByUser && existing.label !== draftItem.label ? existing.label : draftItem.label;
        target.value = protectedByUser && existing.value !== computedValue ? existing.value : computedValue;
        target.factKeys = draftItem.factKeys;
        target.valueFactKey = draftItem.valueFactKey;
        target.calculation = draftItem.calculation;
        target.completed = existing.completed;
        target.locked = existing.locked;
        target.edited = existing.edited;
        target.stale = completedNeedsReview || ((existing.edited || hasMeaningfulPreparation(existing)) && valueChanged) || existing.stale;
        preservePreparation(target, existing);

        if (valueChanged) {
          if (existing.locked) {
            const id = conflictId('locked', existing.id, draftItem.valueFactKey);
            pushConflict(conflicts, {
              id,
              itemId: existing.id,
              kind: 'locked',
              factKey: draftItem.valueFactKey,
              message: `${existing.label} is locked and conflicts with the source update.`,
            });
            pushChange(changes, {
              id: changeId(existing.id, 'locked'),
              targetId: existing.id,
              label: existing.label,
              before: existing.value,
              after: computedValue,
              status: 'needs_review',
              reason: 'The user locked this item, so the source update needs an explicit choice.',
              evidence,
            });
          } else if (existing.edited) {
            pushChange(changes, {
              id: changeId(existing.id, 'edited'),
              targetId: existing.id,
              label: existing.label,
              before: existing.value,
              after: computedValue,
              status: 'needs_review',
              reason: 'The user edited this item; it is preserved and marked stale for review.',
              evidence,
            });
          } else if (hasMeaningfulPreparation(existing) || completedNeedsReview) {
            pushChange(changes, {
              id: changeId(existing.id, 'preparation'),
              targetId: existing.id,
              label: existing.label,
              before: existing.value,
              after: computedValue,
              status: 'needs_review',
              reason: completedNeedsReview
                ? 'Prior completion was preserved; changed work requires explicit review.'
                : 'The user-owned preparation settings were preserved and marked stale for review.',
              evidence,
            });
          } else {
            pushChange(changes, {
              id: changeId(existing.id, 'item'),
              targetId: existing.id,
              label: existing.label,
              before: existing.value,
              after: computedValue,
              status: 'changed',
              reason: 'Dependent workspace item changed.',
              evidence,
            });
          }
        } else if (completedNeedsReview) {
          pushChange(changes, {
            id: changeId(existing.id, 'completed-dependency'),
            targetId: existing.id,
            label: existing.label,
            before: existing.value,
            after: target.value,
            status: 'needs_review',
            reason: 'The completed task depends on changed facts and needs explicit review.',
            evidence,
          });
        } else if (existing.completed || existing.locked || existing.edited) {
          pushChange(changes, {
            id: changeId(existing.id, 'preserved'),
            targetId: existing.id,
            label: existing.label,
            before: existing.value,
            after: target.value,
            status: 'preserved',
            reason: 'User state was preserved.',
            evidence,
          });
        }
      } else {
        block.items.push({
          id: stableId,
          key: draftItem.key,
          label: draftItem.label,
          value: computedValue,
          factKeys: draftItem.factKeys,
          valueFactKey: draftItem.valueFactKey,
          calculation: draftItem.calculation,
          completed: false,
          locked: false,
          edited: false,
          stale: false,
        });
        pushChange(changes, {
          id: changeId(stableId, 'item-added'),
          targetId: stableId,
          label: draftItem.label,
          before: '',
          after: computedValue,
          status: 'changed',
          reason: 'New workspace item was added.',
          evidence,
        });
      }
    }
  }

  for (const block of next.blocks) {
    for (const existing of block.items) {
      if (processedItemIds.has(existing.id) || removalItemIds.has(existing.id)) continue;
      const affectedByChangedFact = intersects(existing.factKeys, changedFactKeys);
      const affectedBySourceConflict = intersects(existing.factKeys, sourceConflictedFactKeys);
      if (!affectedByChangedFact && !affectedBySourceConflict) continue;

      const evidence = itemEvidence(existing, nextFactsByKey);
      if (existing.locked) {
        pushConflict(conflicts, {
          id: conflictId('locked', existing.id, existing.valueFactKey),
          itemId: existing.id,
          kind: 'locked',
          factKey: existing.valueFactKey,
          message: `${existing.label} is locked and depends on changed source facts.`,
        });
        pushChange(changes, {
          id: changeId(existing.id, 'omitted-locked'),
          targetId: existing.id,
          label: existing.label,
          before: existing.value,
          after: existing.calculation && !affectedBySourceConflict ? computeItemValue(existing, nextFactsByKey) : existing.value,
          status: 'needs_review',
          reason: 'The proposal omitted a locked item affected by changed facts.',
          evidence,
        });
        continue;
      }

      if (existing.calculation && affectedByChangedFact && !affectedBySourceConflict && !existing.edited) {
        const calculated = computeItemValue(existing, nextFactsByKey);
        if (existing.value !== calculated) {
          pushChange(changes, {
            id: changeId(existing.id, 'omitted-calculation'),
            targetId: existing.id,
            label: existing.label,
            before: existing.value,
            after: calculated,
            status: existing.completed ? 'needs_review' : 'changed',
            reason: 'A calculation item was omitted but recalculated from changed facts.',
            evidence,
          });
          existing.value = calculated;
        }
        if (existing.completed) existing.stale = true;
        continue;
      }

      existing.stale = true;
      pushChange(changes, {
        id: changeId(existing.id, 'omitted-dependent'),
        targetId: existing.id,
        label: existing.label,
        before: existing.value,
        after: existing.value,
        status: 'needs_review',
        reason: 'The proposal omitted a non-calculated item that depends on changed source facts.',
        evidence,
      });
    }
  }

  for (const removal of parsedDraft.removedItems) {
    const evidence = locateEvidence(input.sources, removal.sourceId, removal.quote);
    const existing = nextIndex.itemsById.get(removal.itemId);
    if (!existing) continue;
    const protectedDeletion = existing.item.edited || existing.item.completed || existing.item.locked || hasMeaningfulPreparation(existing.item);
    if (protectedDeletion) {
      pushConflict(conflicts, {
        id: conflictId('deletion', existing.item.id),
        itemId: existing.item.id,
        kind: 'deletion',
        factKey: existing.item.valueFactKey,
        message: `${existing.item.label} has user state and cannot be deleted without a choice.`,
      });
      pushChange(changes, {
        id: changeId(existing.item.id, 'delete-protected'),
        targetId: existing.item.id,
        label: existing.item.label,
        before: existing.item.value,
        after: '',
        status: 'needs_review',
        reason: 'Deletion targets user-edited, completed, locked, or preparation state.',
        evidence: [evidence],
      });
    } else {
      existing.block.items = existing.block.items.filter((item) => item.id !== existing.item.id);
      pushChange(changes, {
        id: changeId(existing.item.id, 'delete'),
        targetId: existing.item.id,
        label: existing.item.label,
        before: existing.item.value,
        after: '',
        status: 'changed',
        reason: 'Source update removed this unprotected item.',
        evidence: [evidence],
      });
    }
  }

  recalculateDerivedItems(next);

  enforceSnapshotLimits(next);

  return {
    id: input.id ?? `changeset:${crypto.randomUUID()}`,
    baseRevision: input.baseRevision,
    baseSourceRevision: input.baseSourceRevision,
    proposalRevision: 1,
    summary: parsedDraft.summary,
    questions: parsedDraft.questions,
    changes,
    conflicts,
    next: snapshotSchema.parse(next),
    createdAt: input.now ?? new Date().toISOString(),
  };
};

export const resolveChangeSet = (changeSet: ChangeSet, currentSnapshot: Snapshot, resolutions: Resolution[]): Snapshot => {
  if (changeSet.questions.length > 0) {
    throw new DomainError('UNANSWERED_QUESTIONS', 'Change sets with open questions cannot be applied');
  }
  const current = cloneSnapshot(currentSnapshot);
  validateSnapshotIdentity(current);
  const next = cloneSnapshot(changeSet.next);
  validateSnapshotIdentity(next);
  const resolutionById = new Map(resolutions.map((resolution) => [resolution.conflictId, resolution.choice]));
  const proposedChangeByTarget = new Map(changeSet.changes.map((change) => [change.targetId, change]));

  for (const conflict of changeSet.conflicts) {
    const choice = resolutionById.get(conflict.id);
    if (!choice) throw new DomainError('UNRESOLVED_CONFLICT', `Missing resolution for ${conflict.id}`);
  }

  const currentIndex = indexSnapshot(current);
  const nextIndex = indexSnapshot(next);
  const sourceConflictChoices = new Map<string, Resolution['choice']>();

  for (const conflict of changeSet.conflicts) {
    const choice = resolutionById.get(conflict.id);
    if (!choice) throw new DomainError('UNRESOLVED_CONFLICT', `Missing resolution for ${conflict.id}`);
    if (conflict.kind === 'source' && conflict.factKey) {
      const sourceFact = nextIndex.factsByKey.get(conflict.factKey);
      const userFact = currentIndex.factsByKey.get(conflict.factKey);
      const proposedChange = sourceFact ? proposedChangeByTarget.get(sourceFact.id) : undefined;
      if (choice === 'keep_user' && sourceFact && userFact) {
        sourceFact.value = userFact.value;
        sourceFact.evidence = userFact.evidence;
        sourceFact.semantic = userFact.semantic;
      } else if (choice === 'use_source' && sourceFact && proposedChange) {
        sourceFact.value = typeof userFact?.value === 'number' ? Number(proposedChange.after) : proposedChange.after;
        sourceFact.evidence = proposedChange.evidence[0] ?? sourceFact.evidence;
        if ('afterSemantic' in proposedChange) sourceFact.semantic = proposedChange.afterSemantic;
      }
      sourceConflictChoices.set(conflict.factKey, choice);
      continue;
    }

    if (!conflict.itemId) continue;
    const sourceItem = nextIndex.itemsById.get(conflict.itemId);
    const userItem = currentIndex.itemsById.get(conflict.itemId);

    if (conflict.kind === 'deletion') {
      if (choice === 'keep_user' && !sourceItem && userItem) {
        let block = next.blocks.find((candidate) => candidate.id === userItem.block.id);
        if (!block) {
          block = { ...userItem.block, items: [] };
          next.blocks.push(block);
        }
        block.items.push(structuredClone(userItem.item));
      }
      if (choice === 'use_source' && sourceItem) {
        sourceItem.block.items = sourceItem.block.items.filter((item) => item.id !== conflict.itemId);
      }
      continue;
    }

    if (conflict.kind === 'locked' && sourceItem && userItem) {
      if (choice === 'keep_user') {
        sourceItem.item.label = userItem.item.label;
        sourceItem.item.value = userItem.item.value;
        sourceItem.item.locked = userItem.item.locked;
        sourceItem.item.edited = userItem.item.edited;
        sourceItem.item.completed = userItem.item.completed;
        preservePreparation(sourceItem.item, userItem.item);
        sourceItem.item.stale = true;
      } else {
        const proposedChange = proposedChangeByTarget.get(sourceItem.item.id);
        if (proposedChange) sourceItem.item.value = proposedChange.after;
        sourceItem.item.locked = userItem.item.locked;
        sourceItem.item.edited = false;
        sourceItem.item.completed = userItem.item.completed;
        preservePreparation(sourceItem.item, userItem.item);
        sourceItem.item.stale = userItem.item.stale || userItem.item.completed || hasMeaningfulPreparation(userItem.item);
      }
    }
  }

  if (sourceConflictChoices.size > 0) {
    const factsByKey = new Map(next.facts.map((fact) => [fact.key, fact]));
    for (const block of next.blocks) {
      for (const candidate of block.items) {
        const relevantChoices = candidate.factKeys.flatMap((key) => {
          const choice = sourceConflictChoices.get(key);
          return choice ? [choice] : [];
        });
        if (relevantChoices.length === 0) continue;

        const userItem = currentIndex.itemsById.get(candidate.id)?.item;
        const proposedChange = proposedChangeByTarget.get(candidate.id);
        const allUseSource = relevantChoices.every((choice) => choice === 'use_source');
        const anyUseSource = relevantChoices.some((choice) => choice === 'use_source');
        if (candidate.locked || candidate.edited) {
          if (userItem) {
            candidate.label = userItem.label;
            candidate.value = userItem.value;
            candidate.factKeys = userItem.factKeys;
            candidate.valueFactKey = userItem.valueFactKey;
            candidate.calculation = userItem.calculation;
            candidate.completed = userItem.completed;
            candidate.locked = userItem.locked;
            candidate.edited = userItem.edited;
            preservePreparation(candidate, userItem);
            candidate.stale = anyUseSource ? true : userItem.stale;
          }
          continue;
        }
        if (allUseSource) {
          if (candidate.calculation) candidate.value = computeItemValue(candidate, factsByKey);
          else if (proposedChange) candidate.value = proposedChange.after;
          candidate.stale = candidate.stale || candidate.completed || hasMeaningfulPreparation(candidate);
        } else if (userItem) {
          candidate.label = userItem.label;
          candidate.value = userItem.value;
          candidate.factKeys = userItem.factKeys;
          candidate.valueFactKey = userItem.valueFactKey;
          candidate.calculation = userItem.calculation;
          candidate.completed = userItem.completed;
          preservePreparation(candidate, userItem);
          candidate.stale = anyUseSource ? true : userItem.stale;
        }
      }
    }
  }

  recalculateDerivedItems(next);
  enforceSnapshotLimits(next);
  return snapshotSchema.parse(next);
};

export const editItem = (snapshot: Snapshot, request: z.infer<typeof editItemSchema>): Snapshot => {
  const parsed = editItemSchema.parse(request);
  const next = cloneSnapshot(snapshot);
  const target = indexSnapshot(next).itemsById.get(parsed.itemId);
  if (!target) throw new DomainError('ITEM_NOT_FOUND', `Unknown item ${parsed.itemId}`, 404);
  const hadPreparation = hasMeaningfulPreparation(target.item);

  if (parsed.label !== undefined) {
    target.item.label = parsed.label;
    target.item.edited = true;
  }
  if (parsed.value !== undefined) {
    target.item.value = parsed.value;
    target.item.edited = true;
    target.item.calculation = null;
  }
  if (parsed.completed !== undefined) target.item.completed = parsed.completed;
  if (parsed.locked !== undefined) target.item.locked = parsed.locked;
  if (parsed.preparation !== undefined) {
    if (target.block.type !== 'checklist') throw new DomainError('PREPARATION_CHECKLIST_ONLY', 'Preparation can be set only on checklist items');
    if (parsed.preparation.dueDate === null && parsed.preparation.durationMinutes === null) {
      delete target.item.preparation;
    } else {
      target.item.preparation = parsed.preparation;
    }
  }
  if (parsed.acknowledgeReview === true) {
    if (target.block.type !== 'checklist') throw new DomainError('REVIEW_ACK_CHECKLIST_ONLY', 'Review acknowledgement can be set only on checklist items');
    target.item.stale = false;
  }
  const ordinaryEdit = parsed.label !== undefined || parsed.value !== undefined || parsed.completed !== undefined || parsed.locked !== undefined;
  // Checklist edits do not acknowledge changed work, even after completion is toggled off.
  if (ordinaryEdit && target.block.type !== 'checklist' && !hadPreparation && !hasMeaningfulPreparation(target.item)) {
    target.item.stale = false;
  }

  return snapshotSchema.parse(next);
};
