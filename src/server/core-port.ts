import { buildChangeSet, editItem, resolveChangeSet } from '../core/engine';
import { SAMPLE_SCENARIOS, type SampleScenario, type SampleScenarioKey } from '../core/samples';

export const corePort = { buildChangeSet, resolveChangeSet, editItem };

export type CorePort = typeof corePort;

export const sampleScenarios = SAMPLE_SCENARIOS;

export type SampleScenarios = typeof sampleScenarios;

export type { SampleScenario, SampleScenarioKey };
