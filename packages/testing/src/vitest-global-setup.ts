// Entry point referenced by vitest.config.ts. Vitest loads it in its main
// process, where coverage isn't collected, so it only re-exports the tested
// implementation in global-setup.ts.
export { default } from './global-setup.js';
