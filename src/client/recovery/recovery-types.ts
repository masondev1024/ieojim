import type { RecoveryActionStatus, RecoveryActionView, RecoveryView } from '../../core/recovery-api-contracts';
import type { CalendarConnectionSummary } from '../../core/calendar-contracts';
import type { RecoveryInput, RecoveryResult, ScheduleEvent } from '../../core/scheduling-contracts';

export type RecoveryMode = 'local' | 'persisted';
export type ExternalActionStatus = 'not_configured' | 'ready' | 'pending' | 'applied' | 'accepted' | 'failed' | 'needs_review';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
export type PreviewStatus = 'idle' | 'dirty' | 'previewing' | 'failed';

export type RecoveryDraft = {
  preparationMinutes: number;
  submissionDeadline: string;
  expenseLocked: boolean;
  availability1430: boolean;
};

export type RecoveryPlan = {
  version: 1;
  synthetic: boolean;
  timezone: 'Asia/Seoul';
  noticeReceivedAt: string;
  changedNotice: string;
  draft: RecoveryDraft;
  input: RecoveryInput;
  result: RecoveryResult;
  confirmedConstraints: string[];
  before: ScheduleEvent[];
  after: ScheduleEvent[];
  movedEventIds: string[];
  protectedEventIds: string[];
  feasible: boolean;
  violations: Array<{ code: string; message: string; blockers: string[] }>;
  summary: {
    preparationWindow: string | null;
    movedTask: string | null;
    protectedCount: number;
    calendarActions: number;
    draftRecipients: string[];
  };
  external: {
    calendar: ExternalActionStatus;
    email: ExternalActionStatus;
  };
  approval: {
    approved: boolean;
    approvedAt: string | null;
    invalidatedReason: string | null;
  };
  server?: RecoveryView;
};

export type RecoveryApiFailure = {
  code: string;
  message: string;
  status?: number;
};

export type RecoveryEvent = ScheduleEvent;
export type { CalendarConnectionSummary, RecoveryActionStatus, RecoveryActionView, RecoveryInput, RecoveryResult, RecoveryView, ScheduleEvent };
