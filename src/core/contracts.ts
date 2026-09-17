import { z } from 'zod';
import { MODEL_POLICY, MODEL_RESERVE_MICRO_USD } from './model-policy';

export const LIMITS = { sourceChars: 6000, totalSourceChars: 24000, purposeChars: 300, maxSources: 12, maxFacts: 48, maxBlocks: 8, maxItems: 48, outputTokens: MODEL_POLICY.outputTokens, inputTokens: MODEL_POLICY.inputTokens, reserveMicroUsd: MODEL_RESERVE_MICRO_USD, retentionMs: 7 * 24 * 60 * 60 * 1000 } as const;
export const keySchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const scalarSchema = z.union([z.string().max(600), z.number().finite()]);
export const answerRequestSchema = z.object({
  changeSetId: z.string().min(1).max(100), proposalRevision: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative(), baseSourceRevision: z.number().int().nonnegative(),
}).strict();
export const sourceAnswerSchema = answerRequestSchema.extend({ questions: z.array(z.string().max(240)).min(1).max(5) });
export type SourceAnswer = z.infer<typeof sourceAnswerSchema>;
export const sourceSchema = z.object({
  id: z.string(), text: z.string().min(1).max(LIMITS.sourceChars), title: z.string().max(100),
  relation: z.enum(['initial', 'addition', 'correction', 'replacement']), targetSourceId: z.string().nullable(),
  hash: z.string(), createdAt: z.string(),
  answerTo: sourceAnswerSchema.optional(),
}).strict();
export type Source = z.infer<typeof sourceSchema>;
export const evidenceSchema = z.object({ sourceId: z.string(), quote: z.string().min(1).max(800), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export const calculationSchema = z.object({ kind: z.literal('divide'), totalFactKey: keySchema, divisorFactKey: keySchema }).strict();
export type Calculation = z.infer<typeof calculationSchema>;
export const factSemanticSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('money'), unit: z.literal('KRW') }).strict(),
  z.object({ kind: z.literal('count'), unit: z.enum(['person', 'household', 'item', 'case', 'team', 'seat']) }).strict(),
  z.object({
    kind: z.literal('date_time'),
    date: z.string().regex(/^(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/).optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    timezone: z.literal('Asia/Seoul').optional(),
  }).strict().refine((value) => value.date !== undefined || value.time !== undefined, 'date_time semantics require date or time'),
]);
export type FactSemantic = z.infer<typeof factSemanticSchema>;
export const factSchema = z.object({ id: z.string(), key: keySchema, label: z.string().max(120), value: scalarSchema, evidence: evidenceSchema, semantic: factSemanticSchema.nullable().optional() }).strict();
export type Fact = z.infer<typeof factSchema>;
export const itemPreparationSchema = z.object({
  version: z.literal(1),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Preparation dueDate must be a real YYYY-MM-DD date').nullable(),
  durationMinutes: z.number().int().min(1).max(1440).nullable(),
}).strict();
export type ItemPreparation = z.infer<typeof itemPreparationSchema>;
export const itemSchema = z.object({
  id: z.string(), key: keySchema, label: z.string().max(120), value: z.string().max(1200),
  factKeys: z.array(keySchema).max(12), valueFactKey: keySchema.nullable(), calculation: calculationSchema.nullable(),
  completed: z.boolean(), locked: z.boolean(), edited: z.boolean(), stale: z.boolean(),
  preparation: itemPreparationSchema.optional(),
}).strict();
export type BlockItem = z.infer<typeof itemSchema>;
export const blockSchema = z.object({ id: z.string(), key: keySchema, type: z.enum(['schedule', 'cost', 'checklist', 'note']), title: z.string().max(120), items: z.array(itemSchema).max(16) }).strict();
export type Block = z.infer<typeof blockSchema>;
export const snapshotSchema = z.object({ facts: z.array(factSchema).max(LIMITS.maxFacts), blocks: z.array(blockSchema).max(LIMITS.maxBlocks) }).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const emptySnapshot = (): Snapshot => ({ facts: [], blocks: [] });

// The model returns bounded patches, not executable code or authoritative user state.
const draftOperationSchema = z.enum(['create', 'update']);
export const draftFactSchema = z.object({ key: keySchema, label: z.string().max(120), value: scalarSchema, sourceId: z.string(), quote: z.string().min(1).max(800) }).strict();
export const liveDraftFactV2Schema = draftFactSchema.extend({ operation: draftOperationSchema, targetFactKey: keySchema.nullable(), semantic: factSemanticSchema.nullable() }).strict();
export const draftItemSchema = z.object({ key: keySchema, label: z.string().max(120), value: z.string().max(600), factKeys: z.array(keySchema).max(12), valueFactKey: keySchema.nullable(), calculation: calculationSchema.nullable() }).strict();
export const liveDraftItemV2Schema = draftItemSchema.extend({ operation: draftOperationSchema, targetItemId: z.string().nullable() }).strict();
export const legacyDraftSchema = z.object({
  summary: z.string().max(600), questions: z.array(z.string().max(240)).max(5),
  facts: z.array(draftFactSchema).max(LIMITS.maxFacts),
  blocks: z.array(z.object({ key: keySchema, type: z.enum(['schedule', 'cost', 'checklist', 'note']), title: z.string().max(120), items: z.array(draftItemSchema).max(16) }).strict()).max(LIMITS.maxBlocks),
  removedItems: z.array(z.object({ itemId: z.string(), sourceId: z.string(), quote: z.string().min(1).max(800) }).strict()).max(16),
}).strict();
export const liveDraftV2Schema = z.object({
  schemaVersion: z.literal(2),
  summary: z.string().max(600), questions: z.array(z.string().max(240)).max(5),
  facts: z.array(liveDraftFactV2Schema).max(LIMITS.maxFacts),
  blocks: z.array(z.object({ key: keySchema, type: z.enum(['schedule', 'cost', 'checklist', 'note']), title: z.string().max(120), items: z.array(liveDraftItemV2Schema).max(16) }).strict()).max(LIMITS.maxBlocks),
  removedItems: z.array(z.object({ operation: z.literal('remove'), itemId: z.string(), sourceId: z.string(), quote: z.string().min(1).max(800) }).strict()).max(16),
}).strict();
export const draftSchema = z.union([legacyDraftSchema, liveDraftV2Schema]);
export type LiveProposalDraftV2 = z.infer<typeof liveDraftV2Schema>;
type LegacyDraft = z.infer<typeof legacyDraftSchema>;
type LiveDraftFactV2 = z.infer<typeof liveDraftFactV2Schema>;
type LiveDraftItemV2 = z.infer<typeof liveDraftItemV2Schema>;
export type ProposalDraft = {
  schemaVersion?: 2;
  summary: LegacyDraft['summary'];
  questions: LegacyDraft['questions'];
  facts: Array<LegacyDraft['facts'][number] & Partial<Pick<LiveDraftFactV2, 'operation' | 'targetFactKey' | 'semantic'>>>;
  blocks: Array<Omit<LegacyDraft['blocks'][number], 'items'> & { items: Array<LegacyDraft['blocks'][number]['items'][number] & Partial<Pick<LiveDraftItemV2, 'operation' | 'targetItemId'>>> }>;
  removedItems: Array<LegacyDraft['removedItems'][number] & Partial<{ operation: 'remove' }>>;
};
export type Change = {
  id: string; targetId: string; label: string; before: string; after: string; status: 'changed' | 'preserved' | 'needs_review'; reason: string; evidence: Evidence[];
  beforeSemantic?: FactSemantic | null; afterSemantic?: FactSemantic | null;
};
export type Conflict = { id: string; itemId: string | null; message: string; kind: 'locked' | 'deletion' | 'source'; factKey: string | null };
export type Resolution = { conflictId: string; choice: 'keep_user' | 'use_source' };
export type ChangeSet = {
  id: string; baseRevision: number; baseSourceRevision: number; proposalRevision: number;
  summary: string; questions: string[]; changes: Change[]; conflicts: Conflict[];
  next: Snapshot; createdAt: string;
};
export type RunStatus = 'pending' | 'running' | 'ready' | 'needs_input' | 'failed' | 'uncertain' | 'applied';
export type RunSummary = { id: string; sourceId: string; status: RunStatus; error: string | null; createdAt: string; costMicroUsd: number | null; mode: 'live' | 'fixture' };
export type RevisionSummary = { revision: number; createdAt: string; reason: string };
export type SampleScenarioName = 'travel' | 'syllabus' | 'departure' | 'coordination';
export type WorkspaceView = { id: string; title: string; purpose: string; sampleScenario: SampleScenarioName | null; revision: number; sourceRevision: number; sources: Source[]; snapshot: Snapshot; pending: ChangeSet | null; runs: RunSummary[]; history: RevisionSummary[]; expiresAt: string };
export type WorkspaceSummary = { id: string; title: string; updatedAt: string; revision: number };
export type AppConfig = { liveAvailable: boolean; maxSourceChars: number; retentionDays: number };
export type ApiError = { error: { code: string; message: string } };

export const createWorkspaceSchema = z.object({ title: z.string().trim().min(1).max(100), purpose: z.string().trim().min(1).max(LIMITS.purposeChars) }).strict();
export const addSourceSchema = z.object({ text: z.string().trim().min(1).max(LIMITS.sourceChars), title: z.string().trim().min(1).max(100), relation: z.enum(['initial', 'addition', 'correction', 'replacement']), targetSourceId: z.string().nullable(), requestId: z.string().uuid(), answerTo: answerRequestSchema.optional() }).strict();
export const editItemSchema = z.object({ baseRevision: z.number().int().nonnegative(), requestId: z.string().uuid(), itemId: z.string(), label: z.string().max(120).optional(), value: z.string().max(600).optional(), completed: z.boolean().optional(), locked: z.boolean().optional(), preparation: itemPreparationSchema.optional(), acknowledgeReview: z.literal(true).optional() }).strict();
export const applySchema = z.object({ changeSetId: z.string(), baseRevision: z.number().int().nonnegative(), baseSourceRevision: z.number().int().nonnegative(), proposalRevision: z.number().int().positive(), requestId: z.string().uuid(), resolutions: z.array(z.object({ conflictId: z.string(), choice: z.enum(['keep_user', 'use_source']) }).strict()).max(48) }).strict();
export const restoreSchema = z.object({ revision: z.number().int().nonnegative(), baseRevision: z.number().int().nonnegative(), requestId: z.string().uuid() }).strict();
export const sampleScenarioSchema = z.object({ scenario: z.enum(['travel', 'syllabus', 'departure', 'coordination']) }).strict();
export const sampleUpdateSchema = z.object({ step: z.enum(['update', 'conflict']), requestId: z.string().uuid() }).strict();
export const retrySchema = z.object({ runId: z.string(), requestId: z.string().uuid() }).strict();

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); this.name = 'DomainError'; }
}
