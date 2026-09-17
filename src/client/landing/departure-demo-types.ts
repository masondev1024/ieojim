export type DepartureChoice = 'keep_user' | 'use_source';

export type DepartureEvidence = { title: string; quote: string };

export type DepartureChange = {
  id: string;
  label: string;
  before: string;
  after: string;
  evidence: DepartureEvidence[];
};

export type DepartureDecision = DepartureChange & {
  kind: 'locked' | 'deletion';
  keepLabel: string;
  sourceLabel: string;
};

export type DepartureResultRow = {
  id: string;
  label: string;
  before: string;
  after: string;
  state: string[];
};

export type DepartureDemoModel = {
  source: { title: string; text: string };
  changes: DepartureChange[];
  decisions: DepartureDecision[];
  preservedNote: { label: string; value: string; needsReview: boolean };
  resolve: (choices: Record<string, DepartureChoice>) => DepartureResultRow[];
};
