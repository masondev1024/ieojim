/// <reference types="@cloudflare/vitest-plugin/types" />
import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { cleanAuthenticationMetadata } from '../../src/server/auth-maintenance';

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const now = new Date('2026-09-10T00:00:00.000Z');
const created = '2026-09-09T00:00:00.000Z';
const activeExpiry = '2026-09-11T00:00:00.000Z';
beforeEach(async () => { await reset(); await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });

async function user(id: string) {
  await testEnv.DB.prepare('INSERT INTO auth_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES(?,?,?,1,?,?)')
    .bind(id, 'Synthetic', `${id}@example.test`, created, created).run();
}
async function session(id: string, expiry: string, at = created) {
  await testEnv.DB.prepare('INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES(?,?,?, ?,?,?)')
    .bind(id, `test-${id}`, 'user', expiry, at, at).run();
}
async function verification(id: string, expiry: string, at = created) {
  await testEnv.DB.prepare('INSERT INTO auth_verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES(?,?,?, ?,?,?)')
    .bind(id, id, 'synthetic-only', expiry, at, at).run();
}

it('reclaims expired auth metadata while preserving active credentials and account identity', async () => {
  await user('user');
  await session('expired', now.toISOString());
  await session('active', activeExpiry);
  await verification('expired', now.toISOString());
  await verification('active', activeExpiry);
  await testEnv.DB.prepare('INSERT INTO auth_admission_days(day,login_attempts) VALUES(?,?)').bind('2026-07-01', 1).run();
  await cleanAuthenticationMetadata(testEnv.DB, now);
  expect((await testEnv.DB.prepare('SELECT id FROM auth_session').all()).results).toEqual([{ id: 'active' }]);
  expect((await testEnv.DB.prepare('SELECT id FROM auth_verification').all()).results).toEqual([{ id: 'active' }]);
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM auth_user').first('COUNT(*)')).toBe(1);
  expect(await testEnv.DB.prepare('SELECT day FROM auth_admission_days WHERE day = ?').bind('2026-07-01').first()).toBeNull();
});

it('bounds authentication accounts and sessions and admits a replacement after expiry', async () => {
  await testEnv.DB.prepare('UPDATE auth_policy SET max_accounts = 1, max_sessions = 1, max_sessions_per_account = 1').run();
  await user('user');
  await expect(user('overflow')).rejects.toThrow('IEOJIM_AUTH_ADMISSION_LIMIT');
  await session('old', now.toISOString());
  await expect(session('too-soon', activeExpiry)).rejects.toThrow('IEOJIM_AUTH_ADMISSION_LIMIT');
  expect(await testEnv.DB.prepare('SELECT id FROM auth_session').first('id')).toBe('old');
  await session('replacement', activeExpiry, now.toISOString());
  expect(await testEnv.DB.prepare('SELECT id FROM auth_session').first('id')).toBe('replacement');
});

it('does not refund daily login admission when pending OAuth state is consumed', async () => {
  await testEnv.DB.prepare('UPDATE auth_policy SET max_daily_logins = 1').run();
  await verification('first', activeExpiry);
  await testEnv.DB.prepare('DELETE FROM auth_verification').run();
  await expect(verification('second', activeExpiry)).rejects.toThrow('IEOJIM_AUTH_ADMISSION_LIMIT');
  expect(await testEnv.DB.prepare('SELECT login_attempts FROM auth_admission_days WHERE day = ?').bind(created.slice(0, 10)).first('login_attempts')).toBe(1);
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM auth_verification').first('COUNT(*)')).toBe(0);
  await verification('next-day', activeExpiry, now.toISOString());
});

it('fails closed for new auth metadata when the admission policy is missing', async () => {
  await user('user');
  await testEnv.DB.prepare('DELETE FROM auth_policy').run();
  await expect(user('new-user')).rejects.toThrow('IEOJIM_AUTH_POLICY_MISSING');
  await expect(session('new-session', activeExpiry)).rejects.toThrow('IEOJIM_AUTH_POLICY_MISSING');
  await expect(verification('new-state', activeExpiry)).rejects.toThrow('IEOJIM_AUTH_POLICY_MISSING');
  expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM auth_admission_days').first('COUNT(*)')).toBe(0);
});
