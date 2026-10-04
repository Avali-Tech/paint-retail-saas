import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const dist = fileURLToPath(new URL('./dist', import.meta.url));
const migrations = fileURLToPath(new URL('../../packages/db/migrations', import.meta.url));

// The demo seed (src/demo/cli.ts) as one file in dist/demo/seed.js, bundled the
// same way as the server (vite.config.ts). It looks for migrations in
// dist/migrations, copied here too so it works without the server build.
export default defineConfig({
  build: {
    ssr: 'src/demo/cli.ts',
    outDir: 'dist/demo',
    target: 'node24',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'seed.js' } },
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
