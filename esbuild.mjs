import * as esbuild from 'esbuild';

const args = process.argv.slice(2);
const production = args.includes('--production');
const watch = args.includes('--watch');
const tests = args.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  external: ['vscode'],
  logLevel: 'info',
};

const builds = [{ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' }];

if (tests) {
  builds.push(
    { ...common, entryPoints: ['test/unit.test.ts'], outfile: 'out/test/unit.test.js' },
    { ...common, entryPoints: ['test/integration/run.ts'], outfile: 'out/test/integration/run.js', external: ['vscode', '@vscode/test-electron'] },
    { ...common, entryPoints: ['test/integration/suite.ts'], outfile: 'out/test/integration/suite.js' },
    { ...common, entryPoints: ['test/integration/multi.ts'], outfile: 'out/test/integration/multi.js' },
  );
}

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
