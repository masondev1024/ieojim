import { z } from 'zod';
import type { NoticeRecoveryOrigin } from './notice-recovery';
import type { CalendarVerificationView } from './recovery-verification-contracts';
import { recoveryInputSchema, type RecoveryInput, type RecoveryResult } from './scheduling-contracts';

export const recoveryActionStatusSchema = z.enum(['queued', 'executing', 'verified', 'accepted', 'uncertain', 'conflict', 'failed', 'cancelled']);
export type RecoveryActionStatus = z.infer<typeof recoveryActionStatusSchema>;
export type RecoveryActionView = {
  id: string;
  kind: 'calendar' | 'email';
  status: RecoveryActionStatus;
  message: string;
  createdAt: string;
  baseRevision?: number;
  sourceRevision?: number;
  conditionRevision?: number;
  verifiedEvents?: number;
  totalEvents?: number;
  verification?: CalendarVerificationView;
};
export type RecoveryView = {
  workspaceId: string;
  revision: number;
  sourceRevision: number;
  conditionRevision: number;
  input: RecoveryInput;
  result: RecoveryResult;
  proposalId: string;
  applied: boolean;
  actions: RecoveryActionView[];
  origin?: NoticeRecoveryOrigin;
};
const requestId = z.string().uuid();
const revision = z.number().int().nonnegative();
export const createRecoverySchema = z.object({ input: recoveryInputSchema, requestId }).strict();
export const previewRecoverySchema = createRecoverySchema.extend({ baseRevision: revision, conditionRevision: revision }).strict();
export const applyRecoverySchema = z.object({ proposalId: z.string().min(1).max(100), baseRevision: revision, conditionRevision: revision, requestId }).strict();
export const executeRecoverySchema = z.object({ baseRevision: revision, conditionRevision: revision, requestId, approved: z.literal(true) }).strict();
export const emailRecoverySchema = executeRecoverySchema.extend({
  recipient: z.email().max(254).refine((value) => !/[\r\n]/.test(value)),
  subject: z.string().trim().min(1).max(160).refine((value) => !/[\r\n]/.test(value)),
  body: z.string().trim().min(1).max(4000),
}).strict();
