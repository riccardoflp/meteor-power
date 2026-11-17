import { JsParseOptions } from './jsParser';

/** The text before the cursor is the start of a method or publication name, inside a string. */
export interface NameCompletionContext {
  kind: 'method' | 'publication';
  /** The quote opening the string. */
  quote: string;
  /** What is already typed of the name. */
  typed: string;
}

const STRING_ARG = String.raw`\s*\(\s*(['"\x60])([^'"\x60]*)$`;
const BUILTIN_METHOD = String.raw`\bMeteor\s*\.\s*(?:call|callAsync|apply|applyAsync)`;
// `Meteor.subscribe`, `this.subscribe`, `instance.subscribe`, `useSubscribe` from meteor/react-meteor-data
const BUILTIN_SUBSCRIBE = String.raw`\.\s*subscribe|(?<![\w$])useSubscribe`;

/**
 * A call to one of the project's wrappers (`meteorPower.methods.callFunctions`, `publications.subscribeFunctions`),
 * matched like the parser does: a bare name also as a property (`Api.callMethod`), a path (`Api.call`) only as is.
 */
function wrapperPattern(name: string): string | undefined {
  const segs = name.trim().split('.').filter(Boolean);
  if (!segs.length || !segs.every((s) => /^[\w$]+$/.test(s))) return undefined;
  const path = segs.map((s) => s.replace(/\$/g, '\\$')).join(String.raw`\s*\.\s*`);
  return segs.length === 1 ? String.raw`(?<![\w$])${path}` : String.raw`(?<![\w$.])${path}`;
}

function callRegExp(builtin: string, wrappers: string[] | undefined): RegExp {
  const alts = [builtin, ...(wrappers ?? []).flatMap((w) => wrapperPattern(w) ?? [])];
  return new RegExp(`(?:${alts.join('|')})${STRING_ARG}`);
}

const cache = new WeakMap<JsParseOptions, { methods: RegExp; publications: RegExp }>();

/** Whether `prefix` (the line up to the cursor) ends inside the name argument of a method call or a subscription. */
export function nameCompletionContext(prefix: string, options: JsParseOptions = {}): NameCompletionContext | undefined {
  let re = cache.get(options);
  if (!re) {
    re = { methods: callRegExp(BUILTIN_METHOD, options.methodCallers), publications: callRegExp(BUILTIN_SUBSCRIBE, options.subscribeCallers) };
    cache.set(options, re);
  }
  const method = re.methods.exec(prefix);
  if (method) return { kind: 'method', quote: method[1], typed: method[2] };
  const pub = re.publications.exec(prefix);
  if (pub) return { kind: 'publication', quote: pub[1], typed: pub[2] };
  return undefined;
}
