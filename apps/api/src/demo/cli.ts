// Entry point for `node dist/demo/seed.js <seed|reset|status>` (built by
// vite.demo.config.ts, run by `pnpm demo`). All logic lives in seed-command.ts.
import 'reflect-metadata';
import { runSeedCommand } from './seed-command.js';

try {
  process.exitCode = await runSeedCommand(process.argv[2], process.env, (line) => {
    console.log(line);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
