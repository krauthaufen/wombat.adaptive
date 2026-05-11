// AST-level rewrite of adaptive-combinator call sites to memoizing
// equivalents. Pure (no IO); exported for unit-testing without spinning
// up Vite.
//
// Strategy:
//   1. Parse the source via the TypeScript compiler API.
//   2. Track imports from the `wombat.adaptive` family — figure out which
//      local identifiers refer to which collection-namespace (`AVal`,
//      `ASet`, `AList`, `AMap`) and which constructors (`cval`, `cset`,
//      `clist`, `cmap`).
//   3. Walk the AST. Build a per-binding type-table: locals declared via
//      `const x = cval(...)` (etc.) get tagged with a collection kind,
//      so `x.map(fn)` is recognizable later.
//   4. For every CallExpression, check three call shapes (method,
//      free-function, namespace) against the COMBINATOR table.
//   5. When we know the (kind × combinator) pair → rewrite to
//        __memo([tag, "h:hash", ...sources, fn, ...closureDeps],
//               () => /* original call */)
//   6. Add an injected `import { __memo, TAG_* } from <internalModule>`
//      at the top, listing only the tags we actually used.
//
// We deliberately DO NOT use a TypeChecker — keeping the analysis
// lightweight and zero-config. False negatives (skipping ambiguous calls)
// are preferred over false positives (wrong-memoizing).
//
// Closure-deps analysis: walk the callback's body, collect every
// identifier reference. For each, walk the enclosing-scope chain. If it
// resolves to a binding inside the callback → ignore. If it resolves to
// a top-level (module) binding → ignore (the body hash captures it). If
// it resolves to a binding in an intermediate (enclosing, non-module)
// function/block scope → record it as a closure-dep. We restrict deps to
// bare identifiers and member-access chains (a.b.c) — anything fancier
// causes the call to be skipped (conservative).

import ts from "typescript";

export interface TransformOptions {
  readonly internalModule: string;
}

export interface TransformResult {
  readonly code: string;
  readonly rewriteCount: number;
  readonly tagsUsed: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Combinator table.
// Maps (collection-kind, method-name) → tag-name (string emitted as a
// reference into the runtime substrate).
// ---------------------------------------------------------------------------

type Kind = "aval" | "aset" | "alist" | "amap";

interface ComboEntry {
  readonly tag: string; // e.g. "TAG_AVAL_MAP"
}

const COMBINATORS: Record<Kind, Record<string, ComboEntry>> = {
  aval: {
    map: { tag: "TAG_AVAL_MAP" },
    bind: { tag: "TAG_AVAL_BIND" },
    zipN: { tag: "TAG_AVAL_ZIPN" },
  },
  aset: {
    map: { tag: "TAG_ASET_MAP" },
    bind: { tag: "TAG_ASET_BIND" },
    filter: { tag: "TAG_ASET_FILTER" },
    collect: { tag: "TAG_ASET_COLLECT" },
    choose: { tag: "TAG_ASET_CHOOSE" },
    mapA: { tag: "TAG_ASET_MAPA" },
    filterA: { tag: "TAG_ASET_FILTERA" },
    chooseA: { tag: "TAG_ASET_CHOOSEA" },
  },
  alist: {
    map: { tag: "TAG_ALIST_MAP" },
    bind: { tag: "TAG_ALIST_BIND" },
    filter: { tag: "TAG_ALIST_FILTER" },
    collect: { tag: "TAG_ALIST_COLLECT" },
    choose: { tag: "TAG_ALIST_CHOOSE" },
    mapi: { tag: "TAG_ALIST_MAPI" },
    filteri: { tag: "TAG_ALIST_FILTERI" },
    choosei: { tag: "TAG_ALIST_CHOOSEI" },
    collecti: { tag: "TAG_ALIST_COLLECTI" },
    mapA: { tag: "TAG_ALIST_MAPA" },
    filterA: { tag: "TAG_ALIST_FILTERA" },
    chooseA: { tag: "TAG_ALIST_CHOOSEA" },
    mapAi: { tag: "TAG_ALIST_MAPAI" },
    filterAi: { tag: "TAG_ALIST_FILTERAI" },
    chooseAi: { tag: "TAG_ALIST_CHOOSEAI" },
  },
  amap: {
    map: { tag: "TAG_AMAP_MAP" },
    bind: { tag: "TAG_AMAP_BIND" },
    filter: { tag: "TAG_AMAP_FILTER" },
    choose: { tag: "TAG_AMAP_CHOOSE" },
    mapA: { tag: "TAG_AMAP_MAPA" },
    filterA: { tag: "TAG_AMAP_FILTERA" },
    chooseA: { tag: "TAG_AMAP_CHOOSEA" },
  },
};

// Member-name → set of plausible kinds (used as a fast first-pass filter).
const METHOD_KINDS: Record<string, ReadonlySet<Kind>> = (() => {
  const out: Record<string, Set<Kind>> = {};
  for (const k of Object.keys(COMBINATORS) as Kind[]) {
    for (const m of Object.keys(COMBINATORS[k])) {
      (out[m] ??= new Set()).add(k);
    }
  }
  return out;
})();

// Namespace identifiers (plain object exports) → kind.
const NAMESPACE_TO_KIND: Record<string, Kind> = {
  AVal: "aval",
  ASet: "aset",
  AList: "alist",
  AMap: "amap",
};

// Constructors / "type-anchor" identifiers — when assigned to a const, the
// LHS binds to that kind.
const CONSTRUCTOR_TO_KIND: Record<string, Kind> = {
  cval: "aval",
  cset: "aset",
  clist: "alist",
  cmap: "amap",
  // `init` from /aval, `constant` from /aval, `delay`, `custom`, `zip`
  // are namespace-qualified. The bare-identifier list stays short to
  // avoid collisions with user code.
};

// Module-id substrings that imply this is a wombat.adaptive import.
const ADAPTIVE_MODULE_RE =
  /(^@aardworx\/wombat\.adaptive(\/.*)?$|wombat\.adaptive\/.*$)/;

// Module-paths whose `map`/`bind`/etc. exports we know are adaptive.
// Maps module-id → kind. Used for free-function form detection.
const MODULE_KIND: ReadonlyArray<{ re: RegExp; kind: Kind }> = [
  { re: /\/aval(\.js)?$|\/adaptiveValue\/adaptiveValue(\.js)?$/, kind: "aval" },
  {
    re: /\/aset(\.js)?$|\/adaptiveHashSet\/adaptiveHashSet(\.js)?$/,
    kind: "aset",
  },
  {
    re: /\/alist(\.js)?$|\/adaptiveIndexList\/adaptiveIndexList(\.js)?$/,
    kind: "alist",
  },
  {
    re: /\/amap(\.js)?$|\/adaptiveHashMap\/adaptiveHashMap(\.js)?$/,
    kind: "amap",
  },
];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function transformAdaptiveMemo(
  code: string,
  fileName: string,
  options: TransformOptions,
): TransformResult | null {
  // Cheap early exit — if the source contains no combinator method names
  // and no namespace tokens, skip parse.
  if (!hasAnyCombinatorToken(code)) return null;

  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ES2022,
    /*setParentNodes*/ true,
    /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const ctx = collectImports(sourceFile);
  collectLocalBindings(sourceFile, ctx);

  const state: RewriteState = {
    rewrites: 0,
    tagsUsed: new Set<string>(),
    needsMemo: false,
  };

  const transformer: ts.TransformerFactory<ts.SourceFile> =
    (transformContext) => (rootNode) => {
      const visit = (node: ts.Node): ts.Node => {
        if (ts.isCallExpression(node)) {
          const replacement = tryRewriteCall(node, ctx, state);
          if (replacement) {
            // Visit children of the *original* callback (so nested calls
            // get rewritten too). The fallback closure body holds the
            // original call expression — but we want *its arguments'
            // children* to also be visited. Easiest: visit the
            // replacement-built `compute` body's inner CallExpression
            // children only via a separate sub-walk on the original.
            const visitedOriginal = ts.visitEachChild(
              node,
              visit,
              transformContext,
            );
            // Rebuild the replacement with the visited inner call:
            return rebuildMemoCall(replacement, visitedOriginal);
          }
        }
        return ts.visitEachChild(node, visit, transformContext);
      };
      return ts.visitNode(rootNode, visit) as ts.SourceFile;
    };

  const result = ts.transform(sourceFile, [transformer]);
  let transformed = result.transformed[0]!;

  if (state.rewrites === 0) {
    result.dispose();
    return null;
  }

  // Inject import of __memo and used tags at the top.
  transformed = injectRuntimeImport(transformed, state, options.internalModule);

  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  const out = printer.printFile(transformed);
  result.dispose();

  return {
    code: out,
    rewriteCount: state.rewrites,
    tagsUsed: state.tagsUsed,
  };
}

// ---------------------------------------------------------------------------
// Cheap pre-filter
// ---------------------------------------------------------------------------

function hasAnyCombinatorToken(code: string): boolean {
  // Method names + namespace tokens — at least one must appear.
  for (const m of Object.keys(METHOD_KINDS)) {
    if (code.includes(m)) {
      // Find a likely call site; we don't try too hard here.
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Import + binding context
// ---------------------------------------------------------------------------

interface FileContext {
  /** Identifier name → kind of namespace it is (e.g. local `AVal` alias). */
  readonly namespaces: Map<string, Kind>;
  /**
   * Identifiers bound to `import * as X from "@aardworx/wombat.adaptive"`
   * (the bare entry, no subpath). `X` re-exports `AVal` / `ASet` / ...
   * as nested namespace objects, so `X.AVal.map(...)` resolves to kind
   * aval via the `NAMESPACE_TO_KIND` table.
   */
  readonly compoundNamespaces: Set<string>;
  /** Identifier name → kind for constructors imported from adaptive (`cval`). */
  readonly constructors: Map<string, Kind>;
  /** Identifier name → kind for `map`/`bind`/etc. imported as a free fn. */
  readonly freeFns: Map<string, { kind: Kind; method: string }>;
  /** Local variable name → kind. Filled by `collectLocalBindings`. */
  readonly locals: Map<string, Kind>;
  /**
   * Identifiers introduced via `import type { X }` / `import { type X }`
   * — they vanish at runtime, so referencing them as closure-deps would
   * raise `ReferenceError: X is not defined`. Walking the callback body
   * we naively see them as free identifiers; this set lets us drop
   * them before emitting the memo key.
   */
  readonly typeOnlyImports: Set<string>;
}

function collectImports(sf: ts.SourceFile): FileContext {
  const ctx: FileContext = {
    namespaces: new Map(),
    compoundNamespaces: new Set(),
    constructors: new Map(),
    freeFns: new Map(),
    locals: new Map(),
    typeOnlyImports: new Set(),
  };

  // First pass: collect type-only imports across ALL modules (not just
  // adaptive). These identifiers don't exist at runtime — we must drop
  // them from closure-dep keys.
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    const wholeIsTypeOnly = clause.isTypeOnly === true;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const spec of clause.namedBindings.elements) {
        if (wholeIsTypeOnly || spec.isTypeOnly === true) {
          ctx.typeOnlyImports.add(spec.name.text);
        }
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && wholeIsTypeOnly) {
      ctx.typeOnlyImports.add(clause.namedBindings.name.text);
    }
    if (clause.name && wholeIsTypeOnly) {
      ctx.typeOnlyImports.add(clause.name.text);
    }
  }

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpec = (stmt.moduleSpecifier as ts.StringLiteral).text;
    if (!ADAPTIVE_MODULE_RE.test(moduleSpec)) continue;

    const moduleKind = MODULE_KIND.find((m) => m.re.test(moduleSpec))?.kind;

    if (!stmt.importClause) continue;
    const clause = stmt.importClause;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const spec of clause.namedBindings.elements) {
        const local = spec.name.text;
        const imported = spec.propertyName?.text ?? local;
        // Namespace object?
        if (NAMESPACE_TO_KIND[imported]) {
          ctx.namespaces.set(local, NAMESPACE_TO_KIND[imported]);
          continue;
        }
        // Constructor?
        if (CONSTRUCTOR_TO_KIND[imported]) {
          ctx.constructors.set(local, CONSTRUCTOR_TO_KIND[imported]);
          continue;
        }
        // Free function (map/bind/filter/collect/choose) — only if
        // module-id pinpoints a kind.
        if (moduleKind && METHOD_KINDS[imported]?.has(moduleKind)) {
          ctx.freeFns.set(local, { kind: moduleKind, method: imported });
          continue;
        }
      }
    }
    // Namespace import (`import * as X from "..."`).
    // - Subpath module (e.g. ".../aset") → X is a single-kind namespace,
    //   `X.map(fn, src)` is treated identically to `ASet.map(...)`.
    // - Bare module (e.g. "@aardworx/wombat.adaptive") → X exposes
    //   sub-namespaces (`X.AVal`, `X.ASet`, ...). Recorded so
    //   `X.AVal.map(...)` resolves later.
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      const local = clause.namedBindings.name.text;
      if (moduleKind) {
        ctx.namespaces.set(local, moduleKind);
      } else if (/^@aardworx\/wombat\.adaptive$/.test(moduleSpec)) {
        ctx.compoundNamespaces.add(local);
      }
    }
  }

  return ctx;
}

function collectLocalBindings(sf: ts.SourceFile, ctx: FileContext): void {
  // Walk all VariableDeclarations: const x = cval(...) → x: aval.
  // Also handle: const x = someExistingAval (when someExistingAval is
  // already known via import or a previous binding).
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        const name = node.name.text;
        const kind = inferKindFromExpression(init, ctx);
        if (kind) ctx.locals.set(name, kind);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Resolve `X` or `X.AVal` as a namespace identifier referring to a
 * known kind. Handles bare-identifier (`X` is a subpath-imported
 * namespace) and PropertyAccess (`X.AVal` where X is a bare adaptive
 * namespace import + AVal is a sub-namespace name).
 */
function namespaceKindOfExpr(
  expr: ts.Expression,
  ctx: FileContext,
): Kind | undefined {
  if (ts.isIdentifier(expr)) return ctx.namespaces.get(expr.text);
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    ts.isIdentifier(expr.name) &&
    ctx.compoundNamespaces.has(expr.expression.text)
  ) {
    return NAMESPACE_TO_KIND[expr.name.text];
  }
  return undefined;
}

/**
 * Detect `<NS>.zip(a, b, c, …)` where `<NS>` resolves (via local
 * namespace bindings or known adaptive imports) to a Kind whose
 * `Zipped` wrapper's `.map`/`.bind` we want to memoise. Returns the
 * underlying aval arguments to be used as cache sources, or `null` if
 * the expression isn't a `zip` call we understand.
 *
 * Strict by design: a call like `getZippedFromSomewhere().map(fn)`
 * doesn't qualify — we can only safely expand when the zip arguments
 * are textually present at this call site.
 */
function unwrapZipCall(
  expr: ts.Expression,
  expectedKind: Kind,
  ctx: FileContext,
): ts.Expression[] | null {
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.name) || callee.name.text !== "zip") return null;
  const ns = namespaceKindOfExpr(callee.expression, ctx);
  if (ns !== expectedKind) return null;
  if (expr.arguments.length === 0) return null;
  return [...expr.arguments];
}

function inferKindFromExpression(
  expr: ts.Expression,
  ctx: FileContext,
): Kind | undefined {
  // Constructor call: cval(...), cset(...), etc.
  if (ts.isCallExpression(expr)) {
    const e = expr.expression;
    if (ts.isIdentifier(e)) {
      const k = ctx.constructors.get(e.text);
      if (k) return k;
      // Free-function call returning a known kind: `map(fn, src)` (we
      // can infer the result's kind from the free-fn entry).
      const f = ctx.freeFns.get(e.text);
      if (f) return f.kind;
    }
    // Namespace.method: AVal.map(fn, av) → aval; ASet.collect → aset.
    // Also handles X.AVal.map(...) when X is a bare adaptive
    // namespace import (compoundNamespaces).
    if (ts.isPropertyAccessExpression(e)) {
      const ns = namespaceKindOfExpr(e.expression, ctx);
      if (ns) return ns;
    }
    // Method call x.map(...) — inherit kind from x.
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const k = ctx.locals.get(e.expression.text);
      if (k) {
        const m = e.name.text;
        if (METHOD_KINDS[m]?.has(k)) return k;
      }
    }
  }
  if (ts.isIdentifier(expr)) {
    const k = ctx.locals.get(expr.text);
    if (k) return k;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Call-site rewrite
// ---------------------------------------------------------------------------

interface RewriteState {
  rewrites: number;
  readonly tagsUsed: Set<string>;
  needsMemo: boolean;
}

interface PendingRewrite {
  readonly tag: string;
  readonly sources: ReadonlyArray<ts.Expression>;
  readonly fn: ts.Expression;
  readonly bodyHash: string;
  readonly closureDeps: ReadonlyArray<ts.Expression>;
  readonly originalCall: ts.CallExpression;
}

function tryRewriteCall(
  call: ts.CallExpression,
  ctx: FileContext,
  state: RewriteState,
): PendingRewrite | null {
  // Detect call shape.
  const detected = detectCombinator(call, ctx);
  if (!detected) return null;
  const { kind, method, sources, fn } = detected;

  const combo = COMBINATORS[kind][method];
  if (!combo) return null;

  // Function-shape check on `fn`.
  if (
    !(
      ts.isArrowFunction(fn) ||
      ts.isFunctionExpression(fn) ||
      ts.isIdentifier(fn) ||
      ts.isPropertyAccessExpression(fn)
    )
  ) {
    return null;
  }

  // Closure-deps analysis (only for inline functions; identifier refs
  // are stable references already).
  let deps: ts.Expression[] = [];
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const result = analyzeClosureDeps(fn, ctx);
    if (result === "skip") return null;
    deps = result;
  }

  const bodyHash = fnv1a32Hex(extractFnText(fn));

  state.rewrites++;
  state.tagsUsed.add(combo.tag);
  state.needsMemo = true;

  return {
    tag: combo.tag,
    sources,
    fn,
    bodyHash,
    closureDeps: deps,
    originalCall: call,
  };
}

interface DetectedCall {
  readonly kind: Kind;
  readonly method: string;
  readonly sources: ReadonlyArray<ts.Expression>;
  readonly fn: ts.Expression;
}

function detectCombinator(
  call: ts.CallExpression,
  ctx: FileContext,
): DetectedCall | null {
  const callee = call.expression;

  // 1) Method form: <expr>.<m>(fn, ...args)
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const method = callee.name.text;
    const candidateKinds = METHOD_KINDS[method];
    if (!candidateKinds) {
      // not a combinator method
    } else {
      // Determine receiver kind. Identifier path is fast (look up local
      // bindings); for any other expression shape — `cval(1).map(...)`,
      // `getList().filter(...)`, parenthesized expressions — fall through
      // to `inferKindFromExpression`, which handles constructor calls
      // and namespace.method chains recursively.
      const receiver = callee.expression;
      let recvKind: Kind | undefined;
      if (ts.isIdentifier(receiver)) {
        recvKind = ctx.locals.get(receiver.text);
      } else {
        recvKind = inferKindFromExpression(receiver, ctx);
      }
      if (recvKind && candidateKinds.has(recvKind) && call.arguments.length >= 1) {
        const fn = call.arguments[0]!;
        // n-ary zip combinator: `<NS>.zip(a, b, ...).map/bind(fn)`.
        // The receiver is a fresh `Zipped` wrapper allocated on every
        // call, so using it as the memo source would never share. We
        // detect the call shape and expand to the underlying avals as
        // sources, switching the tag to TAG_<KIND>_ZIPN so two call
        // sites with identical input avals collapse to one cache key.
        if (recvKind === "aval" && (method === "map" || method === "bind")) {
          const zipArgs = unwrapZipCall(receiver, recvKind, ctx);
          if (zipArgs !== null && COMBINATORS[recvKind].zipN !== undefined) {
            return {
              kind: recvKind,
              method: "zipN",
              sources: zipArgs,
              fn,
            };
          }
        }
        return {
          kind: recvKind,
          method,
          sources: [receiver],
          fn,
        };
      }
      // Namespace form: AVal.map(fn, source) or X.AVal.map(fn, source).
      {
        const ns = namespaceKindOfExpr(receiver, ctx);
        if (ns && candidateKinds.has(ns) && call.arguments.length >= 2) {
          // Namespace signatures vary; in adaptive these are
          // `map(fn, source)` (aset/alist/amap) or `map(source, fn)`
          // (aval). Detect by which arg looks like a function literal.
          const a0 = call.arguments[0]!;
          const a1 = call.arguments[1]!;
          const a0IsFn =
            ts.isArrowFunction(a0) ||
            ts.isFunctionExpression(a0) ||
            ts.isIdentifier(a0);
          const a1IsFn =
            ts.isArrowFunction(a1) ||
            ts.isFunctionExpression(a1) ||
            ts.isIdentifier(a1);
          let fn: ts.Expression | undefined;
          let source: ts.Expression | undefined;
          if (a0IsFn && !a1IsFn) {
            fn = a0;
            source = a1;
          } else if (a1IsFn && !a0IsFn) {
            fn = a1;
            source = a0;
          } else {
            // Heuristic: aval.map(source, fn); others: (fn, source).
            if (ns === "aval") {
              source = a0;
              fn = a1;
            } else {
              fn = a0;
              source = a1;
            }
          }
          if (fn && source) {
            return { kind: ns, method, sources: [source], fn };
          }
        }
      }
    }
  }

  // 2) Free-function form: <id>(fn, source) or (source, fn).
  if (ts.isIdentifier(callee)) {
    const f = ctx.freeFns.get(callee.text);
    if (f && call.arguments.length >= 2) {
      const a0 = call.arguments[0]!;
      const a1 = call.arguments[1]!;
      const a0IsFn =
        ts.isArrowFunction(a0) ||
        ts.isFunctionExpression(a0) ||
        ts.isIdentifier(a0);
      let fn: ts.Expression;
      let source: ts.Expression;
      if (f.kind === "aval") {
        // map(source, fn)
        source = a0;
        fn = a1;
      } else {
        // map(fn, source)
        if (a0IsFn) {
          fn = a0;
          source = a1;
        } else {
          fn = a1;
          source = a0;
        }
      }
      return { kind: f.kind, method: f.method, sources: [source], fn };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Closure-deps analysis
// ---------------------------------------------------------------------------

function analyzeClosureDeps(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  _ctx: FileContext,
): ts.Expression[] | "skip" {
  // Step 1: collect all parameter names of the callback (locals).
  const locals = new Set<string>();
  for (const p of fn.parameters) {
    collectBindingNames(p.name, locals);
  }
  // Also collect names declared inside the function body (var/let/const,
  // function decls, classes).
  collectBodyDeclarations(fn.body, locals);

  // Step 2: walk the body, find Identifier references whose nearest binding
  // is NOT a local. We can't tell module-vs-enclosing without a full scope
  // analysis. As a v1 simplification: every free identifier reference that
  // isn't a builtin nor a top-level-import-name (which we know stable from
  // ctx) is treated as a closure-captured identifier. Since the cache
  // tolerates extra deps (correctness preserved, just a slightly larger
  // key), this is safe.
  //
  // However, we DO want to drop module-level references where possible to
  // avoid bloating keys. We use ctx's known imports + namespaces +
  // constructors as "known stable" names.
  const deps = new Map<string, ts.Expression>();
  let bail = false;

  const visit = (node: ts.Node, scopedLocals: Set<string>): void => {
    if (bail) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const inner = new Set(scopedLocals);
      for (const p of node.parameters) collectBindingNames(p.name, inner);
      collectBodyDeclarations(node.body, inner);
      // Recurse into the body with the inner scope.
      ts.forEachChild(node, (c) => visit(c, inner));
      return;
    }
    if (ts.isBlock(node)) {
      // Block-scoped lets/consts get hoisted into scopedLocals via
      // collectBodyDeclarations on the parent function — we don't
      // re-collect here.
    }
    if (ts.isIdentifier(node)) {
      // Skip if this identifier is the property-name of a property access
      // (`x.foo` — `foo` is not a free var) or a property in object
      // literal (`{ foo: ... }`).
      const parent = node.parent;
      if (parent) {
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.name === node
        ) {
          return;
        }
        if (
          (ts.isPropertyAssignment(parent) ||
            ts.isShorthandPropertyAssignment(parent)) &&
          parent.name === node
        ) {
          // Shorthand `{ x }` IS a reference; PropertyAssignment is the
          // key only if not shorthand.
          if (ts.isPropertyAssignment(parent)) return;
        }
        if (
          ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isBindingElement(parent)
        ) {
          if (parent.name === node) return;
        }
        if (ts.isFunctionDeclaration(parent) && parent.name === node) return;
      }
      const name = node.text;
      if (scopedLocals.has(name)) return;
      if (isBuiltinGlobal(name)) return;
      // Skip names known to be module-level imports/namespaces/constructors
      // — they're stable refs and don't need to participate in the cache key.
      if (
        _ctx.namespaces.has(name) ||
        _ctx.constructors.has(name) ||
        _ctx.freeFns.has(name)
      ) {
        return;
      }
      // Skip type-only imports — they vanish at runtime, so emitting them
      // as closure deps would raise `ReferenceError: X is not defined`.
      if (_ctx.typeOnlyImports.has(name)) {
        return;
      }
      // Treat as closure dep — emit as bare identifier.
      if (!deps.has(name)) {
        deps.set(name, ts.factory.createIdentifier(name));
      }
      return;
    }
    ts.forEachChild(node, (c) => visit(c, scopedLocals));
  };

  visit(fn.body, locals);
  if (bail) return "skip";

  return Array.from(deps.values());
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
    }
  }
}

function collectBodyDeclarations(
  body: ts.Node | undefined,
  out: Set<string>,
): void {
  if (!body) return;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, out);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      out.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name) {
      out.add(node.name.text);
    }
    // Don't descend into nested functions — they have their own scope.
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

const BUILTINS = new Set<string>([
  "undefined",
  "null",
  "true",
  "false",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "JSON",
  "Date",
  "Error",
  "Promise",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "console",
  "globalThis",
  "Infinity",
  "NaN",
  "isFinite",
  "isNaN",
  "parseInt",
  "parseFloat",
  "Reflect",
  "Proxy",
]);

function isBuiltinGlobal(name: string): boolean {
  return BUILTINS.has(name);
}

// ---------------------------------------------------------------------------
// Function-body hash
// ---------------------------------------------------------------------------

// Shared printer with a fixed configuration. The printer's output is
// derived purely from the AST structure — comments stripped, all
// formatting normalized — so the body hash becomes stable across
// equivalent-but-differently-formatted source. `t=>t*2` and
// `t => t * 2` and `t =>   t   *   2` all hash identically.
const HASH_PRINTER = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
  omitTrailingSemicolon: false,
});

function extractFnText(fn: ts.Expression): string {
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const sf = fn.getSourceFile();
    if (sf) return HASH_PRINTER.printNode(ts.EmitHint.Expression, fn, sf);
  }
  if (ts.isIdentifier(fn)) return `<id:${fn.text}>`;
  if (ts.isPropertyAccessExpression(fn)) {
    const sf = fn.getSourceFile();
    if (sf) return HASH_PRINTER.printNode(ts.EmitHint.Expression, fn, sf);
  }
  return "<anon>";
}

function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Replacement-emit
// ---------------------------------------------------------------------------

function rebuildMemoCall(
  pending: PendingRewrite,
  visitedOriginal: ts.Node,
): ts.Node {
  const f = ts.factory;
  // visitedOriginal is the (recursively visited) original CallExpression
  // — we use it both as the fallback closure body and to extract the
  // (possibly rewritten) `fn` argument.
  if (!ts.isCallExpression(visitedOriginal)) {
    return ts.visitEachChild(visitedOriginal, () => visitedOriginal, undefined!);
  }

  const tagRef = f.createIdentifier(pending.tag);
  const hashLit = f.createStringLiteral(`h:${pending.bodyHash}`);

  // Key shape: [tag, hashLiteral, ...sources, ...closureDeps].
  // We deliberately omit the callback identity — its stable identity
  // is captured by the hash. Including the fn reference would defeat
  // the entire scheme for inline lambdas (which re-allocate per call).
  const keyElements: ts.Expression[] = [tagRef, hashLit];
  for (const s of pending.sources) keyElements.push(s);
  for (const d of pending.closureDeps) keyElements.push(d);

  const keyArr = f.createArrayLiteralExpression(keyElements, false);

  const fallback = f.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    visitedOriginal as ts.CallExpression,
  );

  return f.createCallExpression(
    f.createIdentifier("__memo"),
    undefined,
    [keyArr, fallback],
  );
}

// ---------------------------------------------------------------------------
// Inject runtime import
// ---------------------------------------------------------------------------

function injectRuntimeImport(
  sf: ts.SourceFile,
  state: RewriteState,
  moduleId: string,
): ts.SourceFile {
  const f = ts.factory;
  const names: string[] = ["__memo", ...Array.from(state.tagsUsed).sort()];
  const importClause = f.createImportClause(
    /*isTypeOnly*/ false,
    undefined,
    f.createNamedImports(
      names.map((n) =>
        f.createImportSpecifier(false, undefined, f.createIdentifier(n)),
      ),
    ),
  );
  const importDecl = f.createImportDeclaration(
    undefined,
    importClause,
    f.createStringLiteral(moduleId),
    undefined,
  );
  return f.updateSourceFile(sf, [importDecl, ...sf.statements]);
}
