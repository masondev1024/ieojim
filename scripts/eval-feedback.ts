import { lstat, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getAcceptanceCases } from '../src/evaluation/acceptance-cases';
import { loopChallengeCases } from '../src/evaluation/loop-challenge-cases';
import { buildEvaluationFeedback } from '../src/evaluation/feedback';
import { initialCreationCases } from '../src/evaluation/initial-creation';

try {
  const { values } = parseArgs({ options: { report: { type: 'string', multiple: true }, 'plan-out': { type: 'string' } } });
  const paths = values.report ?? [];
  if (!paths.length || paths.length > 20) throw new Error('FEEDBACK_REPORT_COUNT');
  const reports: unknown[] = [];
  for (const path of paths) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('FEEDBACK_REPORT_FILE_LIMIT');
    reports.push(JSON.parse(await readFile(path, 'utf8')) as unknown);
  }
  const feedback = buildEvaluationFeedback(reports, { acceptance: getAcceptanceCases(), 'loop-challenge': loopChallengeCases, 'initial-creation': initialCreationCases });
  if (values['plan-out']) {
    if (!feedback.developmentPlan) throw new Error('FEEDBACK_NO_CODING_TASKS');
    // A new artifact only: never overwrite a frozen plan, evidence or private file.
    await writeFile(values['plan-out'], `${JSON.stringify(feedback.developmentPlan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(feedback, null, 2));
} catch (error) {
  const code = error instanceof Error && /^FEEDBACK_[A-Z_]+$/.test(error.message) ? error.message : 'FEEDBACK_INPUT_OR_OUTPUT_ERROR';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
}
