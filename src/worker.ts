// Parses files off the extension host thread (see src/vscode/parsePool.ts).
import { parentPort } from 'worker_threads';
import { parseDiskFiles } from './core/parseFile';
import type { ParseRequest } from './vscode/parsePool';

parentPort!.on('message', async (req: ParseRequest) => {
  parentPort!.postMessage({ id: req.id, results: await parseDiskFiles(req.files, req.options) });
});
