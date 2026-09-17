import { DomainError } from '../core/contracts';
import { ZodError } from 'zod';

export class ApiException extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ApiException';
  }
}

export function budgetAdmissionError(reason: string | null): ApiException {
  const code = reason ?? 'BUDGET_RESERVATION_FAILED';
  const messages: Record<string, string> = {
    OWNER_DAILY_RUN_LIMIT: '오늘의 AI 실행 한도에 도달했습니다. 한국 시간 오전 9시에 일일 사용량이 초기화됩니다. 저장된 계획은 계속 확인하고 수정할 수 있습니다.',
    DAILY_BUDGET_EXCEEDED: '오늘 서비스 전체 AI 실행 한도에 도달했습니다. 한국 시간 오전 9시에 일일 사용량이 초기화됩니다. 저장된 계획과 체험용 예시는 계속 이용할 수 있습니다.',
    TOTAL_BUDGET_EXCEEDED: '서비스 전체 AI 실행 한도에 도달해 운영자의 확인이 필요합니다. 저장된 계획과 체험용 예시는 계속 이용할 수 있습니다.',
    MODEL_BUDGET_POLICY_VIOLATION: 'AI 실행을 잠시 중단하고 운영자가 확인하고 있습니다. 저장된 계획은 계속 확인하고 수정할 수 있습니다.',
  };
  return new ApiException(code, messages[code] ?? '지금 AI 실행을 시작하지 못했습니다. 입력한 내용을 확인하고 잠시 후 다시 시도해 주세요.', 429);
}

/** Contains HTTP metadata only; never retain a provider response body or key. */
export class ModelHttpError extends Error {
  constructor(public readonly status: number, public readonly reason = 'unknown', public readonly parameter: string | null = null) {
    super('모델 공급자가 요청을 처리하지 못했습니다.');
    this.name = 'ModelHttpError';
  }
}

export type ModelUsage = { inputTokens: number | null; outputTokens: number | null; costMicroUsd: number };

/** Preserve usage metadata when paid generation succeeds but output validation fails. */
export class ModelOutputError extends ApiException {
  constructor(code: string, message: string, status: number, public readonly usage: ModelUsage) {
    super(code, message, status);
    this.name = 'ModelOutputError';
  }
}

export const toApiException = (error: unknown): ApiException => {
  if (error instanceof ApiException) return error;
  if (error instanceof DomainError) return new ApiException(error.code, error.message, error.status);
  if (error instanceof ZodError) return new ApiException('VALIDATION_ERROR', '입력 내용이나 AI 결과의 형식이 맞지 않아 처리하지 못했어요. 기존에 저장한 내용은 유지돼요.', 422);
  if (error instanceof SyntaxError) return new ApiException('INVALID_JSON', '요청 내용을 읽지 못했어요. 다시 시도해 주세요.', 400);
  const storageCode = databaseAdmissionCode(error);
  if (storageCode) return new ApiException(storageCode, storageCode === 'WORKSPACE_HISTORY_LIMIT'
    ? '이 작업 공간의 변경 이력 한도에 도달했습니다. 기존 내용은 계속 확인하거나 삭제할 수 있습니다.'
    : '서비스 저장 또는 요청 한도에 도달했습니다. 기존 내용은 계속 확인하거나 삭제할 수 있습니다.', 429);
  return new ApiException('INTERNAL_ERROR', '요청을 처리하지 못했습니다.', 500);
};

// D1 wraps trigger failures in a cause. Map only our fixed markers; never return
// driver messages (which can contain implementation details) to the client.
const databaseAdmissionCode = (error: unknown): string | null => {
  let cause = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++, cause = cause.cause) {
    if (/\bIEOJIM_STORAGE_LIMIT\b/.test(cause.message)) return 'SERVICE_STORAGE_LIMIT';
    if (/\bIEOJIM_ADMISSION_LIMIT\b/.test(cause.message)) return 'SERVICE_ADMISSION_LIMIT';
    if (/\bIEOJIM_HISTORY_LIMIT\b/.test(cause.message)) return 'WORKSPACE_HISTORY_LIMIT';
  }
  return null;
};
