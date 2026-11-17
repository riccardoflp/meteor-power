import { parse, ParseResult, ParserPlugin } from '@babel/parser';
import type * as t from '@babel/types';
import { emptyFacts, FileFacts } from './model';
import { stripBom } from './text';
import { collectBindings } from './js/bindings';
import { collectObjectMaps, collectTopLevel } from './js/constants';
import { collectAliases } from './js/imports';
import { collectMethodObjects } from './js/methods';
import { createState, CustomFns, JsParseOptions } from './js/state';
import { walk } from './js/walk';

export { moduleId } from './js/imports';
export type { JsParseOptions } from './js/state';

const QUICK_CHECK = /Meteor|meteor\/|Template|[sS]ubscribe|publish|ValidatedMethod|BlazeLayout/;
/** `x.call(`, `Tasks.x.callAsync(`: the root (`x`, `Tasks`) is in group 1. */
const OBJECT_CALL_CHECK = /([\w$]+)[\w$.]*\.(?:call(?:Async|Promise)?|_execute)\s*\(/g;
const IMPORT_CLAUSE = /\bimport\s+([\w$\s{},*]+?)\s+from\s*['"]/g;
/** Files that may only export name constants (e.g. `export const METHODS = { UPDATE: 'users.update' }`). */
const CONSTANTS_CHECK = /\bexport\s+(?:const|let|var|enum|default)\b/;

/**
 * Extracts Meteor/Blaze facts from a JS/TS file.
 * Returns `null` when the file cannot be parsed at all (so callers can keep the previous facts while typing).
 */
export function parseJs(file: string, source: string, options: JsParseOptions = {}): FileFacts | null {
  const facts = emptyFacts(file);
  const text = stripBom(source);
  const custom: CustomFns = {
    methodDefiners: options.methodDefiners ?? [],
    methodCallers: options.methodCallers ?? [],
    publicationDefiners: options.publicationDefiners ?? [],
    subscribeCallers: options.subscribeCallers ?? [],
  };
  const customNames = [...custom.methodDefiners, ...custom.methodCallers, ...custom.publicationDefiners, ...custom.subscribeCallers];
  const mentionsCustom = customNames.some((n) => text.includes(n.split('.').pop()!));
  if (!QUICK_CHECK.test(text) && !CONSTANTS_CHECK.test(text) && !mentionsCustom && !callsImportedObject(text)) return facts;

  const ast = tryParse(file, text);
  if (!ast) return null;

  // the passes, in order: each one reads what the previous ones collected
  const st = createState(file, text, facts, custom, customNames);
  collectTopLevel(st, ast.program);
  collectAliases(st, ast.program);
  collectBindings(st, ast.program);
  collectMethodObjects(st, ast.program);
  collectObjectMaps(st, ast.program);
  walk(st, ast.program, undefined);
  return facts;
}

/**
 * Whether a file may call a ValidatedMethod object imported from elsewhere (`insertTask.call(...)`):
 * a `.call(` on an imported name. Plain `fn.call(this)` is everywhere in libraries, those files are skipped.
 */
function callsImportedObject(text: string): boolean {
  if (!text.includes('import')) return false;
  const imported = new Set<string>();
  for (const m of text.matchAll(IMPORT_CLAUSE)) for (const n of m[1].match(/[\w$]+/g) ?? []) imported.add(n);
  if (!imported.size) return false;
  for (const m of text.matchAll(OBJECT_CALL_CHECK)) if (imported.has(m[1])) return true;
  return false;
}

function tryParse(file: string, text: string): ParseResult<t.File> | undefined {
  const lower = file.toLowerCase();
  const isTs = /\.(ts|tsx|mts|cts)$/.test(lower);
  const plugins: ParserPlugin[] = isTs ? ['typescript', 'decorators-legacy'] : ['jsx', 'decorators-legacy'];
  if (lower.endsWith('.tsx')) plugins.push('jsx');
  const options = {
    sourceType: 'unambiguous' as const,
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    plugins,
  };
  try {
    return parse(text, options);
  } catch {
    // e.g. a `.js` file using TypeScript/Flow syntax: retry with the other dialect
    try {
      return parse(text, { ...options, plugins: isTs ? ['typescript', 'jsx'] : ['flow', 'jsx'] });
    } catch {
      return undefined;
    }
  }
}
