import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Runs the integration suite inside the locally installed VS Code (no download). */
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
  const vscodeExecutablePath =
    process.env.VSCODE_EXECUTABLE ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'integration', 'suite.js'),
    launchArgs: [
      path.join(root, 'test', 'fixtures', 'app'),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--user-data-dir',
      path.join(os.tmpdir(), 'meteorpower-vscode-test'),
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
