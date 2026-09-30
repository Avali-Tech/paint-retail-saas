import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const dist = fileURLToPath(new URL('./dist', import.meta.url));
const migrations = fileURLToPath(new URL('../../packages/db/migrations', import.meta.url));

// Production build: one bundled server file in dist/server, with our workspace
// packages (@paint/*) compiled in and npm packages loaded from node_modules.
// Migrations are copied to dist/migrations, which is where @paint/db looks for
// them relative to the bundled code (../migrations from dist/server).
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist/server',
    target: 'node24',
    sourcemap: true,
    emptyOutDir: true,
  },
  ssr: {
    noExternal: [/^@paint\//],
  },
  plugins: [
    {
      name: 'copy-migrations',
      closeBundle() {
        cpSync(migrations, `${dist}/migrations`, { recursive: true });
      },
    },
  ],
});
