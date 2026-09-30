# Working rules for this repo

1. **Every line of code ships with tests in the same change.** Unit tests (`*.test.ts`) for logic,
   integration tests (`*.int.test.ts`) against a real PostgreSQL via `@paint/testing`. Never mock
   the database in integration tests.
2. `pnpm verify` must pass before committing: format, lint, typecheck, and 100% coverage.
3. Money is integer paise (`@paint/shared`), never floating-point rupees.
4. Build one step at a time and confirm each step before starting the next.

See `README.md` for setup and commands, and the roadmap repo for module IDs (e.g. `P1-M05`).
