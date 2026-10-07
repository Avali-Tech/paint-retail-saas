# Working rules for this repo

1. **Every line of code ships with tests in the same change.** Unit tests (`*.test.ts`) for logic,
   integration tests (`*.int.test.ts`) against a real PostgreSQL via `@paint/testing`. Never mock
   the database in integration tests.
2. `pnpm verify` must pass before committing: format, lint, typecheck, and 100% coverage.
3. Money is integer paise (`@paint/shared`), never floating-point rupees.
4. Branch flow: feature branch → `mvp-N` → `dev` → `release` → `main`, every step a pull request
   that passes CI. Feature PRs target their MVP branch (`mvp-1`, `mvp-2`, …), never `dev` or `main`
   directly. `dev` is the default branch, `release` is what is about to ship, `main` is what is
   live. Only one open change at a time adds database migrations, so migration numbers never clash.
5. Never add Claude attribution (Co-Authored-By or "Generated with") to commits or pull requests.

See `README.md` for setup and commands, and the roadmap repo for module IDs (e.g. `P1-M05`).
