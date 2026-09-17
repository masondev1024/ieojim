import { z } from 'zod';
import { snapshotSchema, sourceSchema } from './contracts';

export const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
export const workspaceExportRevisionSchema = z.object({
  revision: z.number().int().nonnegative(),
  reason: z.string(),
  createdAt: z.string(),
  snapshot: snapshotSchema,
}).strict();
export const workspaceExportContentSchema = z.object({
  workspace: z.object({
    id: z.string(), title: z.string(), purpose: z.string(),
    revision: z.number().int().nonnegative(), sourceRevision: z.number().int().nonnegative(),
    createdAt: z.string(), updatedAt: z.string(), expiresAt: z.string(),
  }).strict(),
  sources: z.array(sourceSchema),
  snapshot: snapshotSchema,
  revisions: z.array(workspaceExportRevisionSchema).max(2).optional(),
}).strict().superRefine((content, context) => {
  const sources = new Map(content.sources.map(source => [source.id, source]));
  assertSnapshotEvidence(content.snapshot, ['snapshot'], sources, context);
  if (content.revisions) {
    const revisionNumbers = content.revisions.map((revision) => revision.revision);
    if (new Set(revisionNumbers).size !== revisionNumbers.length || revisionNumbers.some((revision) => revision !== content.workspace.revision && revision !== content.workspace.revision - 1)) {
      context.addIssue({ code: 'custom', path: ['revisions'], message: 'Export comparison may contain only unique current and immediately preceding revisions.' });
    }
    for (const [revisionIndex, revision] of content.revisions.entries()) {
      assertSnapshotEvidence(revision.snapshot, ['revisions', revisionIndex, 'snapshot'], sources, context);
    }
    const current = content.revisions.find((revision) => revision.revision === content.workspace.revision);
    if (!current || JSON.stringify(current.snapshot) !== JSON.stringify(content.snapshot)) {
      context.addIssue({ code: 'custom', path: ['revisions'], message: 'Export revisions must include the current committed snapshot.' });
    }
  }
});

export const workspaceExportSchema = z.object({
  format: z.literal('ieojim.workspace'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  content: workspaceExportContentSchema,
  checksum: z.object({
    algorithm: z.literal('SHA-256'),
    encoding: z.literal('JSON.stringify(content), UTF-8'),
    value: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();
export type WorkspaceExport = z.infer<typeof workspaceExportSchema>;

function assertSnapshotEvidence(
  snapshot: z.infer<typeof snapshotSchema>,
  path: Array<string | number>,
  sources: Map<string, z.infer<typeof sourceSchema>>,
  context: z.RefinementCtx,
): void {
  for (const [index, fact] of snapshot.facts.entries()) {
    const { sourceId, start, end, quote } = fact.evidence;
    const source = sources.get(sourceId);
    if (!source || start >= end || end > source.text.length || source.text.slice(start, end) !== quote) {
      context.addIssue({ code: 'custom', path: [...path, 'facts', index, 'evidence'], message: 'Export evidence does not match its source.' });
    }
  }
}
