// Gemini Standard text pricing verified 2026-09-09. Thinking is billed as output.
// https://ai.google.dev/gemini-api/docs/pricing
export const MODEL_POLICY = {
  id: 'gemini-3.8-flash',
  inputTokens: 12_000,
  outputTokens: 4_096,
  inputMicroUsdPerToken: 0.75,
  outputMicroUsdPerToken: 3.75,
  priceValidUntil: '2027-01-01T00:00:00.000Z',
} as const;

export const modelCostMicroUsd = (inputTokens: number, outputTokens: number): number =>
  Math.ceil(inputTokens * MODEL_POLICY.inputMicroUsdPerToken + outputTokens * MODEL_POLICY.outputMicroUsdPerToken);

export const MODEL_RESERVE_MICRO_USD = modelCostMicroUsd(MODEL_POLICY.inputTokens, MODEL_POLICY.outputTokens);
