// Command-line entry for the restore drill: `pnpm --filter @paint/ops restore-drill`
// or `node src/restore-drill-cli.ts` in the ops image. All logic lives in tested
// modules (cli-options.ts, restore-drill.ts); this file only wires them to the process.
import { DRILL_USAGE, DrillConfigError, drillOptionsFromEnv } from './cli-options.ts';
import { formatReport, runRestoreDrill } from './restore-drill.ts';

if (process.argv.includes('--help')) {
  console.log(DRILL_USAGE);
} else {
  try {
    const report = await runRestoreDrill(drillOptionsFromEnv(process.env));
    console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof DrillConfigError ? `${error.message}\n\n${DRILL_USAGE}` : error);
    process.exitCode = 2;
  }
}
