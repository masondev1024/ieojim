import { DomainError, type FactSemantic, type Snapshot, type Source } from './contracts';

type FactDraft = { key: string; label: string; value: string | number; sourceId: string; quote: string; semantic?: FactSemantic | null };
type CountUnit = Extract<FactSemantic, { kind: 'count' }>['unit'];

export const normalizeFactLabel = (value: string) => value.replace(/\s+/g, '').toLocaleLowerCase('ko-KR');

const numericTokenPattern = /[+-]?\d[\d,]*(?:\.\d+)?/g;
const strictNumericStringPattern = /^[+-]?\d[\d,]*(?:\.\d+)?$/;
const ambiguousNumericEvidencePattern = /(아닌|아닙|제외|불참|빠져|\d[\d,]*(?:\.\d+)?\s*명?\s*중|각각|각\s+\d|부터|까지|~|-|\/|또는|혹은|약\s*\d|대략\s*\d|내외|정도|이상|이하|초과|미만)/;
const foreignCurrencyPattern = /\$|usd|달러|엔|유로|eur|jpy|cny|위안/i;
const unsafeMoneyPattern = /[+-]\s*\d|아닌|아닙|제외|불참|빠져|부터|까지|~|\/|또는|혹은|약\s*\d|대략\s*\d|내외|정도|이상|이하|초과|미만/;
const strictIntegerToken = String.raw`(?:\d{1,3}(?:,\d{3})+|0|[1-9]\d*)`;

const parseNumericTokens = (quote: string): number[] =>
  [...quote.matchAll(numericTokenPattern)]
    .map(([token]) => Number(token.replaceAll(',', '')))
    .filter(Number.isFinite);

const numericValue = (value: string | number): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  return strictNumericStringPattern.test(trimmed) ? Number(trimmed.replaceAll(',', '')) : null;
};

const safeNonNegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function parseKrwEvidence(quote: string): number | null {
  if (foreignCurrencyPattern.test(quote) || unsafeMoneyPattern.test(quote)) return null;
  if (parseNumericTokens(quote).length !== 1) return null;
  const matches = [
    ...quote.matchAll(new RegExp(String.raw`(?<![\d.,])(${strictIntegerToken})\s*(?:원|KRW)(?![\d.,])`, 'gi')),
    ...quote.matchAll(new RegExp(String.raw`(?:₩|KRW)\s*(${strictIntegerToken})(?![\d.,])`, 'gi')),
    ...quote.matchAll(/(?<![\d.,])(\d+(?:\.\d+)?)\s*만\s*원(?![\d.,])/g),
  ];
  if (matches.length !== 1) return null;
  const [token, raw] = matches[0]!;
  const multiplier = token.includes('만') ? 10_000 : 1;
  const parsed = Number(raw.replaceAll(',', '')) * multiplier;
  return safeNonNegativeInteger(parsed) ? parsed : null;
}

const countUnitPattern: Record<CountUnit, RegExp> = {
  person: /(\d[\d,]*)\s*(?:명|인)/g,
  household: /(\d[\d,]*)\s*가구/g,
  item: /(\d[\d,]*)\s*(?:개|항목)/g,
  case: /(\d[\d,]*)\s*(?:건|사례)/g,
  team: /(\d[\d,]*)\s*팀/g,
  seat: /(\d[\d,]*)\s*(?:석|좌석|자리)/g,
};

export function parseCountEvidence(quote: string, unit: CountUnit): number | null {
  if (ambiguousNumericEvidencePattern.test(quote)) return null;
  const pattern = countUnitPattern[unit as keyof typeof countUnitPattern];
  const matches = [...quote.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const parsed = Number(matches[0]![1]!.replaceAll(',', ''));
  return safeNonNegativeInteger(parsed) ? parsed : null;
}

export function inferFactSemanticForCalculation(fact: { value: string | number; quote: string }, role: 'total' | 'divisor'): FactSemantic | null {
  const value = numericValue(fact.value);
  if (value === null) return null;
  if (role === 'total') return parseKrwEvidence(fact.quote) === value ? { kind: 'money', unit: 'KRW' } : null;
  const numericTokens = parseNumericTokens(fact.quote);
  if (numericTokens.length !== 1 || numericTokens[0] !== value) return null;

  const matches = (Object.keys(countUnitPattern) as CountUnit[])
    .filter((unit) => parseCountEvidence(fact.quote, unit) === value);
  return matches.length === 1 ? { kind: 'count', unit: matches[0]! } : null;
}

const isValidFullDate = (date: string): boolean => {
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
};

const isValidPartialDate = (date: string): boolean => {
  const [month, day] = date.split('-').map(Number);
  if (!month || !day || month < 1 || month > 12) return false;
  const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthDays[month - 1]!;
};

const normalizeDateCandidate = (date: string): string =>
  date.includes('-')
    ? date.split('-').map((part, index) => (index === 0 && part.length === 4 ? part : part.padStart(2, '0'))).join('-')
    : date;

const dateCandidates = (text: string): Set<string> => {
  const candidates = new Set<string>();
  for (const match of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) candidates.add(`${match[1]}-${match[2]}-${match[3]}`);
  for (const match of text.matchAll(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/g)) {
    candidates.add(`${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`);
  }
  const withoutFullKoreanDates = text.replace(/\d{4}년\s*\d{1,2}월\s*\d{1,2}일/g, '');
  for (const match of withoutFullKoreanDates.matchAll(/(\d{1,2})월\s*(\d{1,2})일/g)) {
    candidates.add(`${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`);
  }
  const withoutFullIsoDates = text.replace(/\d{4}-\d{2}-\d{2}/g, '');
  for (const match of withoutFullIsoDates.matchAll(/(?<!\d)(\d{2})-(\d{2})(?!-\d)/g)) candidates.add(`${match[1]}-${match[2]}`);
  return candidates;
};

const containsSemanticDate = (text: string, date: string): boolean => {
  const candidates = dateCandidates(text);
  return candidates.size === 1 && candidates.has(normalizeDateCandidate(date));
};

const parseKoreanTime = (text: string): Set<string> => {
  const times = new Set<string>();
  for (const match of text.matchAll(/(오전|오후)\s*(\d{1,2})시(?:\s*(\d{1,2})분)?/g)) {
    const period = match[1];
    const rawHour = Number(match[2]);
    const minute = Number(match[3] ?? '0');
    if (!Number.isInteger(rawHour) || !Number.isInteger(minute) || rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) continue;
    const hour = period === '오후' ? (rawHour === 12 ? 12 : rawHour + 12) : rawHour === 12 ? 0 : rawHour;
    times.add(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }
  return times;
};

const timeCandidates = (text: string): Set<string> => {
  const candidates = parseKoreanTime(text);
  for (const match of text.matchAll(/(?<!\d)([01]\d|2[0-3]):([0-5]\d)(?!\d)/g)) candidates.add(`${match[1]}:${match[2]}`);
  return candidates;
};

const containsSemanticTime = (text: string, time: string): boolean => {
  const candidates = timeCandidates(text);
  return candidates.size === 1 && candidates.has(time);
};

const containsExplicitTimezone = (text: string): boolean => /Asia\/Seoul|KST|한국\s*시간|서울\s*시간|대한민국\s*시간/i.test(text);

export function assertFactSemanticConsistency(fact: FactDraft, requireRecognizedNumericSemantic: boolean): void {
  const value = numericValue(fact.value);
  if (fact.semantic?.kind === 'money') {
    if (value === null || parseKrwEvidence(fact.quote) !== value) throw new DomainError('SEMANTIC_EVIDENCE_MISMATCH', `KRW fact ${fact.key} does not match its evidence`);
    return;
  }
  if (fact.semantic?.kind === 'count') {
    if (value === null || parseCountEvidence(fact.quote, fact.semantic.unit) !== value) throw new DomainError('SEMANTIC_EVIDENCE_MISMATCH', `Count fact ${fact.key} does not match its evidence`);
    return;
  }
  if (fact.semantic?.kind === 'date_time') {
    const display = String(fact.value);
    if (fact.semantic.date) {
      const validDate = fact.semantic.date.length === 10 ? isValidFullDate(fact.semantic.date) : isValidPartialDate(fact.semantic.date);
      if (!validDate || !containsSemanticDate(fact.quote, fact.semantic.date) || !containsSemanticDate(display, fact.semantic.date)) throw new DomainError('SEMANTIC_EVIDENCE_MISMATCH', `Date fact ${fact.key} does not match its evidence`);
    }
    if (fact.semantic.time) {
      const [hour, minute] = fact.semantic.time.split(':').map(Number);
      if (hour! > 23 || minute! > 59 || !containsSemanticTime(fact.quote, fact.semantic.time) || !containsSemanticTime(display, fact.semantic.time)) throw new DomainError('SEMANTIC_EVIDENCE_MISMATCH', `Time fact ${fact.key} does not match its evidence`);
    }
    if (fact.semantic.timezone) {
      if (!containsExplicitTimezone(fact.quote) || !containsExplicitTimezone(display)) throw new DomainError('SEMANTIC_EVIDENCE_MISMATCH', `Timezone fact ${fact.key} does not match its evidence`);
    }
    return;
  }
  if (requireRecognizedNumericSemantic && value !== null) {
    if (parseKrwEvidence(fact.quote) === value) throw new DomainError('MISSING_FACT_SEMANTIC', `KRW fact ${fact.key} requires money semantics`);
    for (const unit of Object.keys(countUnitPattern) as Array<keyof typeof countUnitPattern>) {
      if (parseCountEvidence(fact.quote, unit) === value) throw new DomainError('MISSING_FACT_SEMANTIC', `Count fact ${fact.key} requires count semantics`);
    }
  }
}

export function assertNumericEvidenceConsistency(fact: FactDraft): void {
  const value = numericValue(fact.value);
  if (value === null || !Number.isFinite(value)) return;
  const krw = parseKrwEvidence(fact.quote);
  if (krw !== null) {
    if (krw !== value) throw new DomainError('NUMERIC_EVIDENCE_MISMATCH', `Numeric fact ${fact.key} does not match its evidence`);
    return;
  }
  const numbers = parseNumericTokens(fact.quote);
  if (numbers.length === 0) {
    throw new DomainError('NUMERIC_EVIDENCE_UNSUPPORTED', `Numeric fact ${fact.key} requires explicit numeric evidence`);
  }
  if (numbers.length !== 1 || ambiguousNumericEvidencePattern.test(fact.quote)) {
    throw new DomainError('NUMERIC_EVIDENCE_AMBIGUOUS', `Numeric fact ${fact.key} has ambiguous numeric evidence`);
  }
  if (numbers[0] !== value) {
    throw new DomainError('NUMERIC_EVIDENCE_MISMATCH', `Numeric fact ${fact.key} does not match its evidence`);
  }
}

export function assertNoTargetedFactIdentityCollision(snapshot: Snapshot, sources: Source[], fact: FactDraft): void {
  if (snapshot.facts.some((existing) => existing.key === fact.key)) return;
  const source = sources.find((candidate) => candidate.id === fact.sourceId);
  if (!source || (source.relation !== 'correction' && source.relation !== 'replacement')) return;

  const normalizedLabel = normalizeFactLabel(fact.label);
  const collision = snapshot.facts.find((existing) =>
    normalizeFactLabel(existing.label) === normalizedLabel && source.targetSourceId === existing.evidence.sourceId,
  );
  if (!collision) return;

  throw new DomainError(
    'FACT_IDENTITY_COLLISION',
    `Fact ${fact.key} appears to rename existing fact ${collision.key}; use the existing key or ask for review`,
  );
}
