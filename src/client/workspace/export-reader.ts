import { MAX_EXPORT_BYTES, workspaceExportSchema, type WorkspaceExport } from '../../core/export-contracts';

export const workspaceExportTimeoutMs = 15_000;

export type LoadedWorkspaceExport = {
  exported: WorkspaceExport;
  text: string;
};

export async function loadWorkspaceExport(workspaceId: string, signal: AbortSignal): Promise<LoadedWorkspaceExport> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/export`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  const text = await readBoundedText(response, MAX_EXPORT_BYTES, signal);
  if (!response.ok) throw readExportFailure(text, response.status);
  const exported = workspaceExportSchema.parse(JSON.parse(text)) as WorkspaceExport;
  if (exported.content.workspace.id !== workspaceId) {
    throw new Error('내려받은 작업 공간이 현재 작업 공간과 일치하지 않습니다.');
  }
  await assertChecksum(exported);
  return { exported, text };
}

export function workspaceExportFailureMessage(error: unknown, fallback = '현재 데이터를 확인하지 못했습니다.'): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '요청 시간이 초과됐습니다. 다시 시도해 주세요.';
  if (error instanceof SyntaxError) return '내려받기 응답 형식이 올바르지 않습니다.';
  if (error instanceof Error && error.name === 'ZodError') return '내려받기 응답 형식이 올바르지 않습니다.';
  if (error instanceof Error) return error.message;
  return fallback;
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('내려받을 데이터가 허용 크기를 넘었습니다.');
  }
  if (!response.body) throw new Error('응답을 안전하게 읽을 수 없습니다. 최신 브라우저에서 다시 시도해 주세요.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DOMException('Aborted', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('내려받을 데이터가 허용 크기를 넘었습니다.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function assertChecksum(payload: WorkspaceExport): Promise<void> {
  const expected = await sha256Hex(JSON.stringify(payload.content));
  if (payload.checksum.value !== expected) throw new Error('내려받은 데이터의 체크섬이 맞지 않습니다.');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readExportFailure(text: string, status: number): Error {
  try {
    const payload = JSON.parse(text) as unknown;
    if (typeof payload === 'object' && payload !== null && 'error' in payload) {
      const error = (payload as { error?: { message?: unknown } }).error;
      if (error && typeof error.message === 'string') return new Error(error.message);
    }
  } catch {
    // Malformed failure bodies are not trusted for user-facing details.
  }
  return new Error(status === 401 ? '로그인 상태를 확인할 수 없습니다. 다시 로그인해 주세요.' : '현재 데이터를 확인하지 못했습니다.');
}
