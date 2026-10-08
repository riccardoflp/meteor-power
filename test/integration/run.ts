import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Runs the integration suite inside the locally installed VS Code (no download). */
async function main() {
  const root = path.resolve(__dirname, '../../..');
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
