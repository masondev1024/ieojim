import { z } from 'zod';

export type AuthenticatedAccount = { id: string; name: string; email: string };
export type GuestClaimWorkspace = { id: string; title: string; revision: number; sourceRevision: number };
export type GuestClaimPreview = { previewHash: string; workspaces: GuestClaimWorkspace[]; retentionDays: number };
export type GuestClaimResult = { claimedCount: number; workspaceIds: string[] };
export type AccountState = {
  authAvailable: boolean;
  provider: 'google';
  user: AuthenticatedAccount | null;
  sessionExpiresAt: string | null;
  guestPreview: GuestClaimPreview | null;
  retentionDays: number;
};

export const accountUsageSchema = z.object({
  asOf: z.string().datetime(),
  retentionDays: z.number().int().positive(),
  activeWorkspaces: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }).strict(),
  aiRunsToday: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive(), resetAt: z.string().datetime() }).strict(),
  workspaces: z.array(z.object({
    id: z.string(), title: z.string(), revision: z.number().int().nonnegative(), sourceRevision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  }).strict()),
}).strict().refine(usage => usage.activeWorkspaces.used === usage.workspaces.length, 'Usage count does not match workspace list.');
export type AccountUsage = z.infer<typeof accountUsageSchema>;

export const claimGuestSchema = z.object({
  requestId: z.string().uuid(),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ClaimGuestInput = z.infer<typeof claimGuestSchema>;
