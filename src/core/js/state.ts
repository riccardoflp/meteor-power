// What the extraction of one file shares between its passes.
import type * as t from '@babel/types';
import { Env, FileFacts, Loc, NameKind } from '../model';
import { envFromPath, LineMap } from '../text';
import type { MemberLike } from './ast';

/** Project-specific helper functions (configured in the settings) that wrap the Meteor APIs. */
export interface JsParseOptions {
  /** e.g. `createMethod('name', fn)`, `createMethod({ name, run })`, `defineMethods({ 'a.b'() {} })` */
  methodDefiners?: string[];
  /** e.g. `callMethod('name', ...args)` */
  methodCallers?: string[];
  publicationDefiners?: string[];
  subscribeCallers?: string[];
  /**
   * The code of a Meteor package, read only for its definitions: large and minified files are parsed too
   * (skipping them would leave the package's definitions unknown).
   */
  library?: boolean;
}

/** The project's wrappers, from {@link JsParseOptions}. */
export interface CustomFns {
  methodDefiners: string[];
  methodCallers: string[];
  publicationDefiners: string[];
  subscribeCallers: string[];
}

/** A name as written in the code, with the range to navigate to. */
export interface NameResult {
  name?: string;
  nameExpr?: string;
  kind: NameKind;
  start: number;
  end: number;
}

/** `obj.key = value`, `obj[key] = value` */
export type MemberAssignment = t.AssignmentExpression & { left: MemberLike };

export interface FileState {
  readonly file: string;
  /** The source, without BOM: node offsets point into it. */
  readonly text: string;
  /** The result, filled by the passes. */
  readonly facts: FileFacts;
  readonly lm: LineMap;
  /** The environment given by the path (`server/`, `client/`), if any. */
  readonly fileEnv: Env | undefined;
  readonly custom: CustomFns;
  /** All of {@link custom}, to skip their checks quickly when there are none. */
  readonly customNames: string[];
  /** Top-level object literals, by variable. */
  readonly objects: Map<string, t.ObjectExpression>;
  /**
   * Local name → what it stands for, used to rewrite constant references before resolving them:
   * `import { A as B }` (B → A), `import * as C` (C → ''), `import D from './x'` (D → @default(path)),
   * `const { X, Y: Z } = A` (X → A.X, Z → A.Y), `const M = A.B` (M → A.B).
   */
  readonly aliases: Map<string, string>;
  /** Every local name bound by an import. */
  readonly imported: Set<string>;
  /** Names of the Meteor object: `Meteor` unless the file declares or imports another `Meteor`, plus `import { Meteor as M }`. */
  readonly meteorNames: Set<string>;
  /** Same for the Blaze `Template` (meteor/templating, meteor/blaze). */
  readonly templateIds: Set<string>;
  /** Same for the `Blaze` namespace and its old name `UI` (`Blaze.registerHelper`, `new Blaze.Template`). */
  readonly blazeIds: Set<string>;
  /** The sets above, by framework global. */
  readonly frameworkIds: Record<string, Set<string>>;
  /**
   * The DDP server, where methods and publications are registered too: variables holding `Meteor.server`
   * and properties assigned from it (`this._server = server || Meteor.server`, then `accounts._server.methods(...)`).
   */
  readonly serverIds: Set<string>;
  readonly serverProps: Set<string>;
  /** Subscribe functions imported from their package (`useSubscribe` from meteor/react-meteor-data). */
  readonly subscribeFns: Set<string>;
  /** Template lifecycle callbacks: inside them `this` is the template instance. */
  readonly lifecycleFns: Set<t.Node>;
  /** Variables whose `.subscribe(name)` is a DDP subscription: template instances and subscription managers. */
  readonly subscribers: Set<string>;
  /** For each enclosing non-arrow function, whether its `this` is a template instance. */
  readonly thisStack: boolean[];
  /** Object literals assigned to a variable anywhere in the file (registrations built inside a function). */
  readonly localObjects: Map<string, t.ObjectExpression>;
  /** `registrations[name] = fn`, `registrations.x = fn`: assignments to a member, by object variable. */
  readonly memberAssignments: Map<string, MemberAssignment[]>;
  /** Variables assigned again (`registrations = other`): their content is not known statically. */
  readonly reassigned: Set<string>;
  /** `const name = 'a.b'` inside functions (top-level ones are in `facts.constants`). */
  readonly localStrings: Map<string, string>;
  /** Every function, and the parts of the code that may not run (if branches, loops, catch, `a && b`). */
  readonly functions: t.Node[];
  readonly conditionalRanges: [number, number][];
}

export function createState(file: string, text: string, facts: FileFacts, custom: CustomFns, customNames: string[]): FileState {
  const meteorNames = new Set(['Meteor']);
  const templateIds = new Set(['Template']);
  const blazeIds = new Set(['Blaze', 'UI']);
  return {
    file,
    text,
    facts,
    lm: new LineMap(text),
    fileEnv: envFromPath(file),
    custom,
    customNames,
    objects: new Map(),
    aliases: new Map(),
    imported: new Set(),
    meteorNames,
    templateIds,
    blazeIds,
    frameworkIds: { Meteor: meteorNames, Template: templateIds, Blaze: blazeIds, UI: blazeIds },
    serverIds: new Set(),
    serverProps: new Set(),
    subscribeFns: new Set(),
    lifecycleFns: new Set(),
    subscribers: new Set(),
    thisStack: [],
    localObjects: new Map(),
    memberAssignments: new Map(),
    reassigned: new Set(),
    localStrings: new Map(),
    functions: [],
    conditionalRanges: [],
  };
}

export function loc(st: FileState, start: number, end: number): Loc {
  return { file: st.file, range: st.lm.range(start, end) };
}

/** The range of a whole node. */
export function nodeLoc(st: FileState, n: t.Node): Loc {
  return loc(st, n.start!, n.end!);
}

/** The range inside the quotes of a string literal. */
export function innerLoc(st: FileState, n: t.Node): Loc {
  return loc(st, n.start! + 1, n.end! - 1);
}

/** The text of the line containing an offset. */
export function lineTextAt(st: FileState, pos: number): string {
  return st.lm.lineText(st.lm.pos(pos).line);
}
