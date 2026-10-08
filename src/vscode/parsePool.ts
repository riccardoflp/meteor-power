import * as os from 'os';
import { Worker } from 'worker_threads';
import { JsParseOptions } from '../core/jsParser';
import { parseDiskFiles, ParsedFile } from '../core/parseFile';

export interface ParseRequest {
  id: number;
  files: { key: string; path: string }[];
  options: JsParseOptions;
}

const CHUNK = 40;

/**
 * Parses many files in parallel on worker threads, so that the initial scan of a large workspace
 * uses several cores and does not block the extension host. The workers only live during a scan.
 * Falls back to parsing on the current thread when workers are not available.
 */
export class ParsePool {
  constructor(
    private readonly script: string,
    readonly size = Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
  ) {}

  /** Parses every file; `onResults` receives them as they arrive. Stops early when `cancelled()` returns true. */
  async parseAll(
    files: { key: string; path: string }[],
    options: JsParseOptions,
    onResults: (results: ParsedFile[]) => void,
    cancelled: () => boolean,
  ): Promise<{ workers: number }> {
    const chunks: { key: string; path: string }[][] = [];
    for (let i = 0; i < files.length; i += CHUNK) chunks.push(files.slice(i, i + CHUNK));
    const count = Math.min(this.size, chunks.length);
    const workers: Worker[] = [];
    try {
      for (let i = 0; i < count; i++) workers.push(new Worker(this.script));
    } catch {
      // no worker threads: parse here
    }
    let next = 0;
    let id = 0;
    const take = () => (cancelled() || next >= chunks.length ? undefined : chunks[next++]);

    const runWorker = async (w: Worker) => {
      for (let chunk = take(); chunk; chunk = take()) {
        const req: ParseRequest = { id: ++id, files: chunk, options };
        try {
          onResults(await request(w, req));
        } catch {
          // the worker died: this chunk and the rest of its share are parsed here
          onResults(await parseDiskFiles(chunk, options));
          return;
        }
      }
    };
    const runHere = async () => {
      for (let chunk = take(); chunk; chunk = take()) {
        onResults(await parseDiskFiles(chunk, options));
        // let the extension host answer other requests between chunks
        await new Promise((r) => setImmediate(r));
      }
    };

    try {
      await Promise.all(workers.length ? workers.map(runWorker) : [runHere()]);
      // chunks left by workers that died
      await runHere();
    } finally {
      for (const w of workers) void w.terminate();
    }
    return { workers: workers.length };
  }
}

function request(w: Worker, req: ParseRequest): Promise<ParsedFile[]> {
  return new Promise((resolve, reject) => {
    const onMessage = (msg: { id: number; results: ParsedFile[] }) => {
      if (msg.id !== req.id) return;
      cleanup();
      resolve(msg.results);
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onError);
    };
    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onError);
    w.postMessage(req);
  });
}
