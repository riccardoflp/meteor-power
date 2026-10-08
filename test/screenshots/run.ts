import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Takes the README screenshots: opens the demo project (docs/demo) and the multi-app fixture in the installed
 * VS Code, performs the actions and captures the window into docs/images. Windows only (PowerShell capture).
 *
 *   npm run screenshots
 */
async function main() {
  const root = path.resolve(__dirname, '../../..');
  const out = path.join(root, 'docs', 'images');
  fs.mkdirSync(out, { recursive: true });

  // a clean profile with a stable look
  const userData = path.join(os.tmpdir(), 'meteor-power-screenshots');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'window.title': 'meteor-power-screenshots ${activeEditorShort}',
        'window.titleBarStyle': 'custom',
        'window.commandCenter': false,
        'window.restoreWindows': 'none',
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'workbench.layoutControl.enabled': false,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.editor.enablePreview': false,
        'chat.disableAIFeatures': true,
        'chat.commandCenter.enabled': false,
        'editor.minimap.enabled': false,
        'editor.fontSize': 14,
        'editor.lineHeight': 21,
        'editor.stickyScroll.enabled': false,
        'editor.inlayHints.enabled': 'off',
        'editor.lightbulb.enabled': 'off',
        'editor.hover.delay': 200,
        'editor.hover.above': false,
        'editor.suggest.showStatusBar': false,
        'breadcrumbs.enabled': false,
        'git.enabled': false,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'extensions.ignoreRecommendations': true,
        'security.workspace.trust.enabled': false,
        'typescript.validate.enable': false,
        'javascript.validate.enable': false,
        'html.suggest.html5': false,
      },
      null,
      2,
    ),
  );

  // the multi-app fixture needs its symlinks (see test/integration/run.ts)
  const multi = path.join(root, 'test', 'fixtures', 'multi');
  for (const name of ['admin', 'web']) {
    const link = path.join(multi, name, 'imports', 'shared');
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(multi, 'shared'), link, 'junction');
  }

  const vscodeExecutablePath =
    process.env.VSCODE_EXECUTABLE ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const runs = [
    { workspace: path.join(root, 'docs', 'demo'), shots: 'demo' },
    { workspace: multi, shots: 'multi' },
  ];
  for (const r of runs) {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'out', 'test', 'screenshots', 'shoot.js'),
      extensionTestsEnv: { SCREENSHOTS_OUT: out, SCREENSHOTS_SET: r.shots },
      // no installed extensions (empty folder) and no built-in TypeScript features: hovers show only Meteor Power
      launchArgs: [
        r.workspace,
        '--extensions-dir',
        path.join(userData, 'extensions'),
        '--disable-extension',
        'vscode.typescript-language-features',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--user-data-dir',
        userData,
      ],
    });
  }
  console.log(`Screenshots saved in ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
