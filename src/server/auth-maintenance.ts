/** Expired credentials are already invalid during request authorization. This
 * bounded maintenance reclaims only expired authentication metadata. */
export async function cleanAuthenticationMetadata(db: D1Database, now = new Date()): Promise<void> {
  const cutoff = now.toISOString();
  const admissionCutoff = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const results = await db.batch([
    db.prepare('DELETE FROM auth_session WHERE "expiresAt" <= ?').bind(cutoff),
    db.prepare('DELETE FROM auth_verification WHERE "expiresAt" <= ?').bind(cutoff),
    db.prepare('DELETE FROM auth_admission_days WHERE day < ?').bind(admissionCutoff),
  ]);
  console.info(JSON.stringify({ event: 'authentication_cleanup', expiredSessions: results[0].meta.changes,
    expiredVerifications: results[1].meta.changes, expiredAdmissionDays: results[2].meta.changes }));
}
