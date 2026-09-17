import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildUtilityTrialReport } from '../src/evaluation/utility-trial';

export async function runUtilityTrialCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 1) throw new Error('UTILITY_TRIAL_USAGE');
  const path = argv[0]!;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error('UTILITY_TRIAL_FILE_LIMIT');
  const report = buildUtilityTrialReport(JSON.parse(await readFile(path, 'utf8')) as unknown);
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  runUtilityTrialCli().catch((error) => {
    const code = error instanceof Error && /^UTILITY_TRIAL_[A-Z_:0-9-]+$/.test(error.message)
      ? error.message
      : 'UTILITY_TRIAL_INPUT_ERROR';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  });
}
