// Bundles the Electron main process, preload script and the browser dev server
// with esbuild. `--watch` rebuilds on change; `--tests` bundles tests/*.test.ts.
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'inline',
  external: ['electron'],
  logLevel: 'info',
  outExtension: { '.js': '.cjs' },
};

if (tests) {
  const dir = 'tests';
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(dir, f)) : [];
  fs.rmSync('dist-tests', { recursive: true, force: true });
  if (entries.length) await build({ ...common, entryPoints: entries, outdir: 'dist-tests' });
  process.exit(0);
}

const options = {
  ...common,
  entryPoints: {
    main: 'electron/main.ts',
    preload: 'electron/preload.ts',
    devserver: 'electron/devserver.ts',
  },
  outdir: 'dist-electron',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
