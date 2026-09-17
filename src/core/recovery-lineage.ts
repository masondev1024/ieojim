import { recoveryInputSchema, type RecoveryInput } from './scheduling-contracts';
import { DomainError } from './contracts';

// Rebase notice spans to the immutable condition source shared by both views.
export function attachRecoverySource(input: RecoveryInput, sourceId: string, text: string): RecoveryInput {
  return bindRecoverySources(input, [{ id: sourceId, text }]);
}

export function bindRecoverySources(input: RecoveryInput, stored: Array<{ id: string; text: string }>): RecoveryInput {
  const bindings = new Map(input.sources.map((source) => {
    const exact = stored.find((entry) => entry.id === source.id && entry.text === source.text);
    const matches = exact ? [exact] : stored.filter((entry) => entry.text.includes(source.text));
    if (matches.length > 1) throw new DomainError('AMBIGUOUS_SOURCE', '같은 안내가 여러 원문에 있습니다. 기준 원문을 명시해 주세요.', 422);
    const target = matches[0];
    if (!target) throw new Error('Recovery notice is not present in the stored source catalog');
    return [source.id, { target, offset: target.text.indexOf(source.text), text: source.text }];
  }));
  const rebase = (evidence: RecoveryInput['events'][number]['evidence'][number]) => {
    const binding = bindings.get(evidence.sourceId);
    if (!binding || binding.text.slice(evidence.start, evidence.end) !== evidence.quote) {
      throw new Error('Recovery evidence is not present in the stored condition source');
    }
    return { ...evidence, sourceId: binding.target.id, start: binding.offset + evidence.start, end: binding.offset + evidence.end };
  };
  return recoveryInputSchema.parse({
    ...input, sources: [...new Map([...bindings.values()].map(({ target }) => [target.id, target])).values()],
    events: input.events.map((event) => ({ ...event, evidence: event.evidence.map(rebase) })),
    relations: input.relations.map((relation) => ({ ...relation, evidence: relation.evidence.map(rebase) })),
  });
}
