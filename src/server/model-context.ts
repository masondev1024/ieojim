import type { Evidence, Snapshot, Source } from '../core/contracts';

const encoder = new TextEncoder();

export type ModelContextMode = 'full' | 'compact';
export type ModelContextInput = {
  purpose: string;
  snapshot: Snapshot;
  sources: Source[];
};
type ModelContextSource = Pick<Source, 'id' | 'title' | 'relation' | 'targetSourceId' | 'text'> & {
  answerTo?: Source['answerTo'];
};
type ModelContextData = {
  purpose: string;
  snapshot: Snapshot;
  sources: ModelContextSource[];
};
export type ModelContextResult = {
  data: unknown;
  requestedMode: ModelContextMode;
  effectiveMode: ModelContextMode;
  fullBytes: number;
  selectedBytes: number;
};

type CompactEvidence = Omit<Evidence, 'quote'>;

type CompactFact = Omit<Snapshot['facts'][number], 'evidence'> & {
  evidence: CompactEvidence;
};

type CompactSnapshot = Omit<Snapshot, 'facts'> & {
  facts: CompactFact[];
};

const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

export function buildModelContext(
  input: ModelContextInput,
  mode: ModelContextMode = 'full',
): ModelContextResult {
  const fullData: ModelContextData = {
    purpose: input.purpose,
    snapshot: input.snapshot,
    sources: projectSources(input.sources),
  };
  const fullBytes = byteLength(fullData);
  if (mode === 'full') return { data: fullData, requestedMode: mode, effectiveMode: 'full', fullBytes, selectedBytes: fullBytes };

  const compactSnapshot = compactEvidenceQuotes(input.snapshot, input.sources);
  if (!compactSnapshot) return { data: fullData, requestedMode: mode, effectiveMode: 'full', fullBytes, selectedBytes: fullBytes };

  const compactData = {
    purpose: input.purpose,
    snapshot: compactSnapshot,
    sources: projectSources(input.sources),
  };
  const selectedBytes = byteLength(compactData);
  if (selectedBytes >= fullBytes) return { data: fullData, requestedMode: mode, effectiveMode: 'full', fullBytes, selectedBytes: fullBytes };
  return { data: compactData, requestedMode: mode, effectiveMode: 'compact', fullBytes, selectedBytes };
}

function compactEvidenceQuotes(snapshot: Snapshot, sources: Source[]): CompactSnapshot | null {
  if (new Set(sources.map((source) => source.id)).size !== sources.length) return null;
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const facts: CompactFact[] = [];
  for (const fact of snapshot.facts) {
    const source = sourcesById.get(fact.evidence.sourceId);
    if (!source || !validEvidenceSlice(fact.evidence, source.text)) return null;
    const evidence: CompactEvidence = {
      sourceId: fact.evidence.sourceId,
      start: fact.evidence.start,
      end: fact.evidence.end,
    };
    facts.push({ ...fact, evidence });
  }
  return { ...snapshot, facts };
}

function validEvidenceSlice(evidence: Evidence, text: string): boolean {
  return Number.isInteger(evidence.start) &&
    Number.isInteger(evidence.end) &&
    evidence.start >= 0 &&
    evidence.end > evidence.start &&
    evidence.end <= text.length &&
    text.slice(evidence.start, evidence.end) === evidence.quote;
}

function projectSources(sources: Source[]): ModelContextSource[] {
  return sources.map(({ id, title, relation, targetSourceId, text, answerTo }) => ({
    id,
    title,
    relation,
    targetSourceId,
    text,
    ...(answerTo ? { answerTo } : {}),
  }));
}
