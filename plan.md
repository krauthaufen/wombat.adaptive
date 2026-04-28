# adaptive-ts

A TypeScript port of [FSharp.Data.Adaptive](https://github.com/fsprojects/FSharp.Data.Adaptive). Foundation layer for an Aardvark-style adaptive system running natively in the browser.

## Working mode

- **Mechanical translation.** Assume every line in the F# source has a reason. Translate token-by-token, preserve structure, do not refactor.
- **Flag, don't fix.** If something looks wrong or non-idiomatic, leave a `// TODO(port):` comment and keep going. Decisions get made by the human reviewer, not in-line by the translator.
- **Tests come with the code.** Each ported source file gets its corresponding test file ported in the same step. Phase isn't done until tests pass.
- **No reinvention.** Public surface may be re-shaped to fit JS conventions; internals stay structurally identical to the F# original.

## Out of scope (explicit)

- **Threading and locking.** JavaScript is single-threaded by event loop. `Monitor.Enter`/`Exit`, `EnterWrite`/`ExitWrite`, the `LockingExtensions` module — all dropped. Level tracking and `LevelChangedException` stay (correctness of nested evaluation, not threading).
- **Custom equality machinery.** F#'s `DefaultEquality`, `IEqualityComparer<T>` indirection, and the `Unchecked.equals` saga are F#-specific. Internally use `===` and `Object.is`. Users wanting structural dedupe wrap with their own equality combinator.
- **Async readers.** `Compute` is synchronous. Adaptive-over-Promise is a future concern, not part of the port.
- **C# wrappers.** TS *is* the wrapper.
- **Fable build.** This is a native TS port, not a Fable artifact.

## Phase plan

Phases are ordered to maximize "first end-to-end success" — AVal works fully before any collection work begins, so the core protocol is proven before more complex pieces are layered on.

### Phase 1 — AVal core foundation
Everything `AVal` needs to compile and run, minus AVal itself. See `phase1.md` for the detailed plan.

- **Files**: `Core/Core.fs`, `Core/AdaptiveToken.fs`, `Core/AdaptiveObject.fs`, `Core/Transaction.fs`, `Core/Callbacks.fs`, `Core/DecoratorObject.fs`, `Utilities/PriorityQueue.fs`.
- **Tests**: `WeakOutputSet.fs`, `Transaction.fs`, `PriorityQueue.fs` (Callbacks tests live in phase 2 since they exercise AVal).
- **Deliverable**: build a hand-written minimal `cval`/`aval.map` end-to-end as a smoke test inside the phase. No public AVal surface yet.
- **Effort**: ~2–3 weeks.

### Phase 2 — AVal proper
Full scalar adaptive system with all combinators and the complete test suite.

- **Files**: `AdaptiveValue/AdaptiveValue.fs` (+ `.fsi`), `AdaptiveValue/AdaptiveReduction.fs` (+ `.fsi`), `Utilities/Cache.fs`, `Utilities/Utilities.fs` (only the bits AVal needs).
- **Tests**: `AVal.fs`, `Callbacks.fs`.
- **Deliverable**: `cval`, `AVal.constant`/`init`/`force`, `map`/`mapN`/`bind`/`bindN`/`custom`, change subscription, eager evaluation, all combinators, all property tests passing.
- **Effort**: ~3–4 weeks.

### Phase 3 — Immutable datastructures
Pure value types. No adaptive layer involved.

- **Files**: `Datastructures/HashCollections.fs`, `HashMap`/`HashSet`/`HashSetDelta`/`HashMapDelta`, `Index`, `IndexList`/`IndexListDelta`, supporting helpers (`MapExt`, `IntMap`, `ArrayBuffer` etc.).
- **Tests**: `HashMap.fs`, `HashSet.fs`, `IndexList.fs`, `IntMap.fs`, plus the `*Reference.fs` oracles for property testing.
- **Effort**: ~5 weeks.

### Phase 4 — History + ASet
Bridge between deltas and the adaptive layer; first op-based collection.

- **Files**: `Traceable/History.fs` and friends, `AdaptiveHashSet/*`, `ChangeableHashSet.fs`, all ASet readers and combinators.
- **Tests**: `ASet.fs`, `History.fs`.
- **Combinator order**: `empty`/`single`/`ofSeq` → `union`/`difference` → `map`/`choose`/`filter` → `collect` → `mapA`/`bindA` → `sortBy`/`groupBy`.
- **Effort**: ~5–6 weeks.

### Phase 5 — AMap
Same shape as ASet, can lift heavily from phase 4 patterns.

- **Files**: `AdaptiveHashMap/*`, `ChangeableHashMap.fs`, all readers and combinators.
- **Tests**: `AMap.fs`.
- **Effort**: ~3–4 weeks.

### Phase 6 — AList
The Index arithmetic makes this the most subtle of the three collections. Deferred to last so all underlying machinery is solid.

- **Files**: `AdaptiveIndexList/*`, `ChangeableIndexList.fs`, all readers and combinators.
- **Tests**: `AList.fs`.
- **Effort**: ~4–5 weeks.

### Parallel track — Adaptify codegen
Independent of the runtime port. Can start once the AVal API stabilizes (end of phase 2).

- TypeScript codegen via `ts-morph` or the TypeScript compiler API.
- Reads user record/union types, emits `*.adaptive.ts` adaptive shells.
- Scope: records, discriminated unions, lists/sets/maps of records.
- **Effort**: ~5–6 weeks.

## Total foundation effort

~5 months of focused work for the runtime; ~6 months including Adaptify and polish.

## Top-level API decisions

These ossify fast; pick early.

### Greenfield principle

This is a greenfield port. **Do not preserve F# names or patterns when a
better TS shape exists.** No deprecated aliases, no compatibility shims,
no "keep for one release just in case." The new shape replaces the old
one cleanly. Argument order, naming, and arity decomposition all get
re-thought against TS idioms and TS type-system capabilities, not
mirrored from F#.

### Module shape

ESM-only single package. `import { aval, cval, ASet, … } from "adaptive-ts"`.

### Combinator surface

**Hybrid: methods for unary, free functions for n-ary, both for
common operations.**

- **Unary**: `x.map(f)`, `x.bind(f)`, `x.mapNonAdaptive(f)`, `x.force()`.
  Methods read left-to-right, IDE auto-completes, JS-idiomatic.
- **N-ary via `zip` wrapper**: `AVal.zip(x, y, z).map((a, b, c) => …)`
  and `AVal.zip(x, y).bind((a, b) => …)`. Variadic, fully type-inferred
  via TS variadic tuple types — no `map2`/`map3`/`bind2`/`bind3`
  surface, no overload soup.
- **N-ary via free function** as a synonym: `AVal.map(x, y, z, (a, b, c) => …)`.
  Same dispatch internals as `zip().map()`.
- **Argument order**: value-first / function-last consistently
  (`x.map(f)`, `AVal.map(x, f)`). Flipped from F#'s pipe-style
  function-first order.

**Why no `mapN`/`bindN` numbered variants** (despite F# having them):
F# had to enumerate them because its tuple types don't carry per-element
types through transformations. TypeScript variadic tuple types do — so
a single `map(...)` infers `(a: number, b: string, c: boolean) => R`
from spread `aval` arguments without overloads. This is one of the few
places where TS is strictly more expressive than F#. Apply the same
zip-pattern principle to *any* n-ary operator we encounter in later
phases (set/map/list combinators with multi-input shapes).

**Internal dispatch**: `map`/`bind` switch on arity. Arity 1/2/3 use
specialised `MapVal`/`Map2Val`/`Map3Val` (and Bind equivalents) with
F#-style partial-constant folding. Arity ≥ 4 uses generic
`MapNVal`/`BindNVal`, which only collapse when *all* inputs are
constant (skipping partial-constant optimisation at high arity is
acceptable — high-arity mostly-dynamic is the common case there).

### Currying

Not preserved. F# `(a -> b -> c)` becomes TS `(a: A, b: B) => C`, not
`(a: A) => (b: B) => C`. F# already un-curries internally via
`OptimizedClosures.FSharpFunc<...>.Adapt` for performance, so the
multi-arg form matches what F# actually runs. Users wanting partial
application write it explicitly.

### Equality

`===` / `Object.is` internally. No pluggable comparer. No
`DefaultEquality` / `IEqualityComparer<T>` indirection.

### WeakRef strategy

Lazy compaction on access in `WeakOutputSet`, no reliance on
`FinalizationRegistry` timing. Add an explicit periodic sweep only if
measurements show a problem.

### Identity semantics

`aval`/`cval`/etc. are reference types. Two `x.map(f)` calls produce
*distinct* AVals with the same value — documented behaviour, not a bug.

## Tooling

- TypeScript, strict mode.
- Test runner: `vitest` (fast, ESM-native, watch mode works well for property tests).
- Property tests: `fast-check` (FsCheck → fast-check is a clean mapping).
- Build: `tsc` for the package, no bundler in the package itself; consumers bundle.
- Lint/format: `prettier` + `eslint` with `@typescript-eslint`. Don't bikeshed configs.
