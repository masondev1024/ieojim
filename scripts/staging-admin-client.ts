import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const account = 'd77fd515103009a324bebb3ac5b81fd9';
const database = '53421a70-d819-4ae6-9eb5-f558a119ea6b';
const queue = 'eb92190445074d2b90db7adf668e4112';
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const require = createRequire(import.meta.url);

type QueryResult = { success: boolean; results?: Record<string, unknown>[] };
type Options = {
  allowRemoteMutation: boolean;
  token?: () => Promise<string>;
  fetch?: typeof fetch;
};

export class StagingAdminError extends Error {
  constructor(public readonly code: string, public readonly constraintViolation = false) {
    super(code);
    this.name = 'StagingAdminError';
  }
}

/** Existing Wrangler OAuth stays in memory; never forward CLI/provider text. */
async function wranglerToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [require.resolve('wrangler'), 'auth', 'token', '--json', '--env', 'staging', '--env-file', '.dev.vars.example'], {
      timeout: 15_000, maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) { reject(new StagingAdminError('staging_auth_unavailable')); return; }
      try {
        const auth: unknown = JSON.parse(stdout);
        if (!isRecord(auth) || typeof auth.token !== 'string' || !auth.token.trim()) throw new Error();
        resolve(auth.token);
      } catch { reject(new StagingAdminError('staging_auth_invalid')); }
    });
  });
}

export async function createStagingAdminClient(options: Options) {
  const token = await (options.token ?? wranglerToken)();
  if (!token.trim()) throw new StagingAdminError('staging_auth_invalid');
  const fetchImpl = options.fetch ?? fetch;
  const requireMutation = () => {
    if (!options.allowRemoteMutation) throw new StagingAdminError('remote_mutation_not_allowed');
  };
  const post = async (path: string, body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${apiRoot}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new StagingAdminError('staging_api_outcome_unknown'); }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(data) || data.success !== true) {
      const errors = isRecord(data) && Array.isArray(data.errors) ? data.errors : [];
      const constraint = errors.some((error: unknown) => isRecord(error) && typeof error.message === 'string' && /CHECK constraint failed/i.test(error.message));
      throw new StagingAdminError('staging_api_rejected', constraint);
    }
    return data.result;
  };

  const query = async (statements: string[], mutates: boolean): Promise<QueryResult[]> => {
    if (mutates) requireMutation();
    if (statements.length < 1 || statements.length > 20 || statements.some((sql) => sql.length > 16_000)) throw new StagingAdminError('invalid_staging_query_batch');
    // Read-only callers cannot smuggle mutation through the flag. SQL in this
    // operator tool is code owned by this repository, never user input.
    if (!mutates && statements.some((sql) => !/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql))) throw new StagingAdminError('invalid_staging_read_query');
    const result = await post(`/d1/database/${database}/query`, { batch: statements.map((sql) => ({ sql })) });
    if (!Array.isArray(result) || result.length !== statements.length || result.some((entry) => !isRecord(entry) || entry.success !== true)) throw new StagingAdminError('invalid_staging_query_result');
    return result as QueryResult[];
  };

  const sendQueueMessage = async (runId: string): Promise<void> => {
    requireMutation();
    if (!/^ops_run_[a-f0-9]{32}$/.test(runId)) throw new StagingAdminError('unsafe_staging_run_id');
    await post(`/queues/${queue}/messages/batch`, { messages: [{ body: { runId }, content_type: 'json' }] });
  };

  const verifyAtomicBatch = async () => {
    requireMutation();
    const id = `ops_guard_${randomUUID().replaceAll('-', '')}`;
    let constraintRejected = false;
    try {
      try {
        await query([
          `INSERT INTO tx_guards (id, created_at) VALUES ('${id}', '${new Date().toISOString()}')`,
          "INSERT INTO tx_abort (id) VALUES ('abort')",
        ], true);
      } catch (error) {
        if (!(error instanceof StagingAdminError) || !error.constraintViolation) throw error;
        constraintRejected = true;
      }
      const check = await query([`SELECT COUNT(*) AS count FROM tx_guards WHERE id = '${id}'`], false);
      if (!constraintRejected || check[0].results?.[0]?.count !== 0) throw new StagingAdminError('staging_batch_not_atomic');
      return { constraintRejected: true, guardRowsAfterFailure: 0 };
    } finally {
      // Only this random probe guard can be touched, even if atomicity failed.
      await query([`DELETE FROM tx_guards WHERE id = '${id}'`], true);
    }
  };

  return { query, sendQueueMessage, verifyAtomicBatch };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
