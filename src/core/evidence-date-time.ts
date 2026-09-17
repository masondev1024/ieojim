import { DomainError, type Fact, type FactSemantic, type Source } from './contracts';
import { assertFactSemanticConsistency } from './proposal-safety';

export type EvidenceDateTime = {
  value: string;
  method: 'stored_semantic' | 'verified_literal';
};

type DateTimeSemantic = Extract<FactSemantic, { kind: 'date_time' }>;

// A derived form value, never a mutation of the provider's draft or stored fact.
export function readEvidenceDateTime(fact: Fact, sources: Source[]): EvidenceDateTime | null {
  const evidence = fact.evidence;
  const source = sources.find((entry) => entry.id === evidence.sourceId);
  if (!source || !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) ||
    evidence.start < 0 || evidence.end <= evidence.start || evidence.end > source.text.length ||
    source.text.slice(evidence.start, evidence.end) !== evidence.quote || typeof fact.value !== 'string') return null;

  let semantic = fact.semantic;
  const method = semantic == null ? 'verified_literal' : 'stored_semantic';
  if (semantic == null) {
    const quoted = parseCompleteLiteral(evidence.quote);
    const displayed = parseCompleteLiteral(fact.value);
    if (!quoted || !displayed || quoted.date !== displayed.date || quoted.time !== displayed.time || quoted.timezone !== displayed.timezone) return null;
    semantic = quoted;
  }
  if (semantic.kind !== 'date_time' || !semantic.date || !/^\d{4}-\d{2}-\d{2}$/.test(semantic.date) ||
    !semantic.time || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(semantic.time) ||
    (semantic.timezone !== undefined && semantic.timezone !== 'Asia/Seoul')) return null;
  try {
    assertFactSemanticConsistency({ key: fact.key, label: fact.label, value: fact.value, sourceId: source.id, quote: evidence.quote, semantic }, false);
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
  return { value: `${semantic.date}T${semantic.time}`, method };
}

function parseCompleteLiteral(text: string): DateTimeSemantic | null {
  const literal = text.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:T|[ \t]+)(.+)$/.exec(literal) ??
    /^(\d{4})년[ \t]*(\d{1,2})월[ \t]*(\d{1,2})일[ \t]*(.+)$/.exec(literal);
  if (!date) return null;
  const time = /^((?:[01]\d|2[0-3]):[0-5]\d|(?:오전|오후)[ \t]*\d{1,2}시(?:[ \t]*\d{1,2}분)?)(?:[ \t]+(KST|Asia\/Seoul|(?:한국|서울|대한민국)[ \t]*시간))?$/i.exec(date[4]!);
  if (!time) return null;
  let clock = time[1]!;
  const korean = /^(오전|오후)[ \t]*(\d{1,2})시(?:[ \t]*(\d{1,2})분)?$/.exec(clock);
  if (korean) {
    const hour = Number(korean[2]);
    const minute = Number(korean[3] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    clock = `${String(hour % 12 + (korean[1] === '오후' ? 12 : 0)).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return {
    kind: 'date_time', date: `${date[1]}-${date[2]!.padStart(2, '0')}-${date[3]!.padStart(2, '0')}`, time: clock,
    ...(time[2] ? { timezone: 'Asia/Seoul' as const } : {}),
  };
}
