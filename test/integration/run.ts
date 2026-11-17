import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Runs the integration suite inside the locally installed VS Code, or a downloaded one when there is none. */
async function main() {
  const root = path.resolve(__dirname, '../../..');

  // Same folder reachable from three other places (like shared imports between apps): app/apps/{a,b,c}/imports/common → app/common.
  // Junctions on Windows, so no admin rights are needed.
  const app = path.join(root, 'test', 'fixtures', 'app');
  for (const name of ['a', 'b', 'c']) {
    const link = path.join(app, 'apps', name, 'imports', 'common');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(app, 'common'), link, 'junction');
  }
  // Two Meteor apps sharing a folder: multi/{admin,web}/imports/shared → multi/shared.
  const multi = path.join(root, 'test', 'fixtures', 'multi');
  for (const name of ['admin', 'web']) {
    const link = path.join(multi, name, 'imports', 'shared');
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(multi, 'shared'), link, 'junction');
  }

  // the local VS Code (VSCODE_EXECUTABLE, or the default install on Windows); elsewhere, as on CI, a downloaded one
  // (VSCODE_VERSION: `stable` by default, or e.g. `1.85.0`, the oldest version package.json accepts)
  const local = process.env.VSCODE_EXECUTABLE ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const vscode = fs.existsSync(local) ? { vscodeExecutablePath: local } : { version: process.env.VSCODE_VERSION ?? 'stable' };
  const runs = [
    { workspace: app, suite: 'suite.js' },
    { workspace: multi, suite: 'multi.js' },
  ];
  for (const r of runs) {
    console.log(`
=== ${path.basename(r.workspace)} ===`);
    await runTests({
      ...vscode,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'out', 'test', 'integration', r.suite),
      // a synthetic Meteor package cache: the tests never read the developer's own
      extensionTestsEnv: { METEOR_WAREHOUSE_DIR: path.join(root, 'test', 'fixtures', 'warehouse') },
      launchArgs: [
        r.workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--user-data-dir',
        path.join(os.tmpdir(), 'meteor-power-vscode-test'),
      ],
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
