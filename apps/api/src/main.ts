// Process entry point for the built server. All logic lives in bootstrap.ts,
// which is tested directly; the built output is exercised by dist.int.test.ts.
import { bootstrap } from './bootstrap.js';

await bootstrap(process.env);
