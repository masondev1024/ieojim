import type { BetterAuthPlugin } from 'better-auth';
import type { OAuthProvider } from 'better-auth/oauth2';

export type AuthProviderBudgetOptions = {
  /**
   * Response deadline for provider-owned OAuth/OIDC operations. Better Auth's
   * public provider API does not accept an AbortSignal, so this is a response
   * budget: the underlying transport may still finish later, but its result is
   * no longer observed by the callback that can create users or sessions.
   */
  deadlineMs?: number;
};

export class AuthProviderBudgetError extends Error {
  readonly code = 'AUTH_PROVIDER_DEADLINE_EXCEEDED';
  readonly operation: string;
  readonly deadlineMs: number;

  constructor(operation: string, deadlineMs: number) {
    super('Authentication provider did not respond before the configured deadline.');
    this.name = 'AuthProviderBudgetError';
    this.operation = operation;
    this.deadlineMs = deadlineMs;
  }
}

type IdTokenJwksConfig = Extract<NonNullable<OAuthProvider['idToken']>, { jwks: unknown }>;
type IdTokenJwks = IdTokenJwksConfig['jwks'];

const defaultDeadlineMs = 12_000;

export function authProviderBudget(options: AuthProviderBudgetOptions = {}): BetterAuthPlugin {
  const deadlineMs = normalizeDeadline(options.deadlineMs);
  return {
    id: 'ieojim-auth-provider-budget',
    version: '0.1.0',
    init(ctx) {
      const provider = ctx.socialProviders.find((candidate) => candidate.id === 'google');
      if (!provider) return;
      wrapGoogleProvider(provider, deadlineMs);
    },
  };
}

function wrapGoogleProvider(provider: OAuthProvider, deadlineMs: number) {
  const validateAuthorizationCode = provider.validateAuthorizationCode.bind(provider);
  provider.validateAuthorizationCode = ((input) => withProviderDeadline(
    validateAuthorizationCode(input),
    'google.validateAuthorizationCode',
    deadlineMs,
  )) satisfies OAuthProvider['validateAuthorizationCode'];

  const getUserInfo = provider.getUserInfo.bind(provider);
  provider.getUserInfo = ((input) => withProviderDeadline(
    getUserInfo(input),
    'google.getUserInfo',
    deadlineMs,
  )) satisfies OAuthProvider['getUserInfo'];

  const idToken = provider.idToken;
  if (idToken && 'jwks' in idToken) {
    const jwks = idToken.jwks;
    provider.idToken = {
      ...idToken,
      jwks: ((...args: Parameters<IdTokenJwks>) => withProviderDeadline(
        Promise.resolve(jwks(...args)),
        'google.idToken.jwks',
        deadlineMs,
      )) satisfies IdTokenJwks,
    };
  }
}

function normalizeDeadline(deadlineMs: number | undefined) {
  if (deadlineMs === undefined) return defaultDeadlineMs;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return defaultDeadlineMs;
  return Math.floor(deadlineMs);
}

async function withProviderDeadline<T>(operation: Promise<T>, label: string, deadlineMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      console.warn(JSON.stringify({ event: 'auth_provider_deadline', operation: label, deadlineMs }));
      reject(new AuthProviderBudgetError(label, deadlineMs));
    }, deadlineMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
