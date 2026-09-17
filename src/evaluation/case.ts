import type { Snapshot, Source } from '../core/contracts';
import type { QualityExpectation } from './eval-quality';
import type { InitialCreationExpectation } from './initial-creation';

/** Synthetic evaluation input, separate from user workspaces and live outputs. */
export type EvaluationCase = {
  id: string;
  purpose: string;
  snapshot: Snapshot;
  sources: Source[];
  expectation: QualityExpectation;
  initialExpectation?: InitialCreationExpectation;
};
