import * as fs from 'fs';
import { parseHtml } from './htmlParser';
import { JsParseOptions, parseJs } from './jsParser';
import { FileFacts } from './model';

/** Files above this size are not indexed. */
export const MAX_SIZE = 1_500_000;

export type SkipReason = 'too large' | 'minified';

export interface ParseResult {
  /** `null`: the file could not be parsed. */
  facts: FileFacts | null;
  skipped?: SkipReason;
}

/**
 * Minified or generated bundles (very long lines): never Meteor source worth indexing,
 * and the slowest files to parse.
 */
export function isMinified(text: string): boolean {
  if (text.length < 20_000) return false;
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  return text.length / lines > 300;
}

export function parseFile(file: string, text: string, options: JsParseOptions): ParseResult {
  if (text.length > MAX_SIZE) return { facts: null, skipped: 'too large' };
  if (isMinified(text)) return { facts: null, skipped: 'minified' };
  return { facts: file.toLowerCase().endsWith('.html') ? parseHtml(file, text) : parseJs(file, text, options) };
}

/** A file parsed from disk: `key` is the path it is indexed under. */
export interface ParsedFile extends ParseResult {
  key: string;
  size: number;
  /** Time spent reading the file and parsing it. */
  readMs: number;
  parseMs: number;
  /** The file could not be read (deleted meanwhile). */
  missing?: boolean;
}

export async function parseDiskFile(key: string, file: string, options: JsParseOptions): Promise<ParsedFile> {
  const start = performance.now();
  try {
    const { size } = await fs.promises.stat(file);
    if (size > MAX_SIZE) return { key, facts: null, skipped: 'too large', size, readMs: performance.now() - start, parseMs: 0 };
    const text = await fs.promises.readFile(file, 'utf8');
    const read = performance.now();
    const r = parseFile(key, text, options);
    return { key, ...r, size, readMs: read - start, parseMs: performance.now() - read };
  } catch {
    return { key, facts: null, missing: true, size: 0, readMs: performance.now() - start, parseMs: 0 };
  }
}

/** Several files: reads overlap, parsing is sequential. */
export function parseDiskFiles(files: { key: string; path: string }[], options: JsParseOptions): Promise<ParsedFile[]> {
  return Promise.all(files.map((f) => parseDiskFile(f.key, f.path, options)));
}
