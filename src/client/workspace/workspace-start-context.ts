import type { SampleScenarioName } from '../../core/contracts';

export type StartTemplate = 'custom' | 'travel' | 'coordination';

export function readStartContext(search: string): {
  template: StartTemplate;
  example: SampleScenarioName | null;
  hasSelection: boolean;
} {
  const params = new URLSearchParams(search);
  const rawTemplate = params.get('template');
  const rawExample = params.get('example');
  const example = rawExample === 'travel' || rawExample === 'departure' || rawExample === 'syllabus' || rawExample === 'coordination'
    ? rawExample : null;
  const template = rawTemplate === 'travel' || rawTemplate === 'coordination' || rawTemplate === 'custom'
    ? rawTemplate
    : rawTemplate !== null ? 'custom'
      : example === 'coordination' ? 'coordination'
        : example === 'travel' || example === 'departure' ? 'travel' : 'custom';
  return { template, example, hasSelection: rawTemplate !== null || rawExample !== null };
}
