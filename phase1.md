# Phase 1 — AVal core foundation

Port everything `AVal` will need to compile and run, *without* AVal itself. End-state: an internal smoke test consisting of a hand-rolled `cval` and one `aval.map`-equivalent runs through `Transaction.Commit` and produces correct values.

## Scope

### Source files in scope

Mapping from F# source to TS targets. All paths in the original repo are under `src/FSharp.Data.Adaptive/`.

| F# source | LOC | TS target | Notes |
|---|---:|---|---|
| `Core/Core.fs` | 487 | `src/core/types.ts`, `src/core/weakOutputSet.ts` | Splits cleanly: `IAdaptiveObject`/`IWeakOutputSet` interfaces in `types.ts`; `WeakOutputSet` + `EmptyOutputSet` in `weakOutputSet.ts`. The F# file has two `WeakOutputSet` impls gated by `#if FABLE_COMPILER` — port the structurally simpler Fable one but use native `WeakRef<T>` instead of strong refs. |
| `Core/AdaptiveToken.fs` | 47 | `src/core/adaptiveToken.ts` | Small struct-like value carrying the calling context. Direct port. |
| `Core/AdaptiveObject.fs` | 304 | `src/core/adaptiveObject.ts` | Drop `Monitor.Enter`/`Exit` calls inside `EvaluateAlways`. Keep level checking, `LevelChangedException`, evaluation depth tracking, `AfterEvaluateCallbacks`. |
| `Core/Transaction.fs` | 360 | `src/core/transaction.ts` | Drop `LockingExtensions` module entirely. `EnterWrite`/`ExitWrite` become no-ops or are removed at call sites. Keep `IndirectOutputObject`, the priority-queue commit walk, `RunningTransaction` as a module-level mutable, finalizer queue. |
| `Core/Callbacks.fs` | 263 | `src/core/callbacks.ts` | `ConditionalWeakTable<K,V>` → `WeakMap<K, V>`. `CallbackDisposable` returns a `() => void` cleanup function. The `makeGCRoot` mechanic stays. |
| `Core/DecoratorObject.fs` | 62 | `src/core/decoratorObject.ts` | Direct port. |
| `Utilities/PriorityQueue.fs` | 452 | `src/utilities/priorityQueue.ts` | Used by `Transaction`. Contains `PriorityQueue` and `DuplicatePriorityQueue`. Direct port. |

**Total: ~1975 lines of F# → roughly the same in TS, possibly slightly less.**

### Test files in scope

| F# test | TS target |
|---|---|
| `Tests/WeakOutputSet.fs` | `tests/weakOutputSet.test.ts` |
| `Tests/Transaction.fs` | `tests/transaction.test.ts` |
| `Tests/PriorityQueue.fs` | `tests/priorityQueue.test.ts` |

`Tests/Callbacks.fs` and `Tests/AVal.fs` exercise AVal-level surface and live in phase 2.

### Internal smoke test (not from F# tests)

A small `tests/_smoke.test.ts` written for this port specifically:

- Hand-roll a minimal `MyCVal` extending `AdaptiveObject` (sets a value, calls `transact` to mark itself).
- Hand-roll a minimal `MyMappedAVal` extending `AdaptiveObject` (overrides `Mark`/`Compute` to apply a function).
- Run a transaction that mutates `MyCVal`, then read `MyMappedAVal` and assert the new mapped value comes out.
- Verify `OutOfDate` flips correctly, `Outputs` adds the right edge, level updates as expected.

Phase 1 isn't done until this passes. It's the proof the core protocol survived translation.

## Translation conventions

### Naming
- F# discriminated unions → TS tagged-union types or classes, depending on usage. Default to tagged unions for data, classes for things with methods (`AdaptiveObject` is a class).
- F# modules with same-named types (e.g. `Transaction` type + `Transaction` module) → class with static members.
- F# `member x.Foo` → method on class. F# `static member` → static method.
- F# `let private` at module level → non-exported `const`/`function` in the same TS module.
- F# `internal` visibility → exported but documented as internal (TS has no enforcement; rely on convention + naming with leading underscore for the genuinely-internal stuff).

### Mutable state
- F# `let mutable foo = 0` → `let foo = 0` (in module scope) or class field.
- F# `ref<T>` → either reassignable `let` or `{ value: T }` wrapper, depending on which gets passed around.

### Locking → no-op
- All `Monitor.Enter x` / `Monitor.Exit x` calls in `EvaluateAlways` and `Transaction.Commit` are deleted.
- `EnterWrite`/`ExitWrite` extension methods on `IAdaptiveObject` are deleted; their call sites delete the calls.
- The `try/finally` blocks that exist purely to release locks collapse to plain code.
- The `LockingExtensions` module is not ported.
- The "WPF SynchronizationContext" comment-and-workaround at the top of `Transaction.Commit` is deleted (no synchronization context exists in JS).

### Equality
- `Unchecked.equals a b` → `Object.is(a, b)` (matches F#'s `Unchecked.equals` semantics for reference types and for primitives more closely than `===`).
- `IEqualityComparer<T>` parameters and `DefaultEqualityComparer` indirection → not ported. Methods that took an equality comparer now use `Object.is` directly.

### Weak references
- `WeakReference<T>` → `WeakRef<T>`. `tryGetTarget : T -> bool * T` → `.deref(): T | undefined`.
- `ConditionalWeakTable<K,V>` → `WeakMap<K, V>`.
- No `FinalizationRegistry` usage in phase 1. The `WeakOutputSet` cleanup is lazy on access (matches the F# Fable variant).

### Exceptions
- `LevelChangedException` → `class LevelChangedException extends Error` with the same payload.
- F# `raise <| Foo` → `throw new Foo(...)`.
- F# `try ... with | Foo -> ...` → `try { ... } catch (e) { if (e instanceof Foo) ... else throw e }`.

### Things to flag, not fix
- Any place where F# uses a feature with no clean TS analogue (e.g. struct layout attributes, aggressive inlining hints, unsafe pointer casts), translate to the closest readable TS equivalent and add `// TODO(port): F# used <feature>; TS equivalent is <approach>. Verify behavior.`.
- Any place where the F# code has a `// TODO` or `// HACK` comment of its own — preserve it verbatim.

## Translation order

Execute in this order. Each step ends with the relevant tests green before moving on.

1. **Project skeleton.** `package.json`, `tsconfig.json` (strict mode, ES2022 target, ESM), `vitest.config.ts`, install dev dependencies (`typescript`, `vitest`, `fast-check`, `@types/node`), `.eslintrc`, `.prettierrc`. ~½ day.
2. **`src/utilities/priorityQueue.ts` + tests.** Self-contained, no dependencies. Port `PriorityQueue` and `DuplicatePriorityQueue`. Get `priorityQueue.test.ts` passing. ~1–2 days.
3. **`src/core/types.ts`.** `IAdaptiveObject`, `IWeakOutputSet` interfaces only. No implementations yet. Compiles in isolation. ~½ day.
4. **`src/core/weakOutputSet.ts` + tests.** `WeakOutputSet` + `EmptyOutputSet`. Port `weakOutputSet.test.ts`. The test file uses `IAdaptiveObject` so we need a tiny test stub class. ~2 days.
5. **`src/core/adaptiveToken.ts`.** Small. ~½ day.
6. **`src/core/adaptiveObject.ts`.** Concrete `AdaptiveObject` class with `EvaluateAlways`, level handling, weak-self-ref cache, `AfterEvaluateCallbacks`. No tests of its own at this stage; tested via Transaction and the smoke test. ~2 days.
7. **`src/core/transaction.ts` + tests.** Port `IndirectOutputObject`, `Transaction` class, the static `RunningTransaction`/`Current` slots, finalizer queue. Port `transaction.test.ts`. ~3–4 days.
8. **`src/core/decoratorObject.ts`.** Small. ~½ day.
9. **`src/core/callbacks.ts`.** `MultiCallbackObject`, `CallbackDisposable`, the `WeakMap<IAdaptiveObject, MultiCallbackObject>` table, public `addCallback`/`addMarkingCallback` helpers. No tests in phase 1 (they exercise AVal). ~2 days.
10. **`tests/_smoke.test.ts`.** The hand-rolled `cval`+`map` end-to-end test described above. Forces all the above to work together. ~1 day to write, plus debugging time for whatever didn't actually work yet.

## Definition of done

- All files in scope translated, compile under `tsc --strict` with zero errors and zero warnings.
- `vitest run` is green: all three ported test files plus the smoke test.
- No usage of `any` outside type-system gaps explicitly documented with a `// TODO(port):` comment.
- `LevelChangedException` exists and is thrown/caught correctly under nested evaluation (smoke test exercises this).
- `WeakOutputSet.consume` behavior matches F# semantics (ported test verifies).
- `Transaction.Commit` correctly processes objects in level order, re-enqueues on level change, calls `Mark`/`InputChanged`/`AllInputsProcessed` in the right order (ported tests verify).
- README in the repo describes how to build and test (~10 lines).

## Risks / things that may need decisions

- **`WeakOutputSet` implementation choice.** F# has two: a Fable-side simple list-of-refs and a .NET-side `VolatileSet` with `StructLayout(LayoutKind.Explicit)` for memory-layout optimization. The Fable one is correct and simple; the .NET one is a perf optimization. Default to porting the Fable variant; note this in the file with a `// TODO(port): consider porting the .NET-side VolatileSet variant if perf measurements demand it.`.
- **`AfterEvaluateCallbacks` thread-static.** F# uses `[<ThreadStatic>]`. JS is single-threaded so this becomes a module-level `let`. No semantic change.
- **`Transaction.Current` and `Transaction.RunningTransaction`.** Same — `[<ThreadStatic>]` becomes a module-level `let`. Verify no callers assume thread-locality (they shouldn't, but worth a `grep`).
- **`PriorityQueue` ordering on equal keys.** F# implementation has specific tie-break behavior; the F# tests likely cover it. If a test fails on tie-breaking, that's a translation bug, not a design question.
- **`ConditionalWeakTable` in `Callbacks.fs`.** `WeakMap<IAdaptiveObject, MultiCallbackObject>` is the direct equivalent, but `WeakMap` keys must be objects (✓, `IAdaptiveObject` is always an object) and there's no enumeration (the F# code may rely on enumeration somewhere — verify by reading the callsites).

## Estimated effort

- ~10–14 working days for translation + tests, assuming no surprises.
- Add 25–50% slack for surprises and review cycles.
- Calendar time: **2–3 weeks.**

## Out of scope for phase 1

- Anything from `AdaptiveValue/`, including `cval`/`AVal.map`/etc. (phase 2)
- `Cache.fs` (phase 2 — used by combinators, not core)
- Any datastructure beyond `PriorityQueue` (phase 3)
- `EvaluationCallbackExtensions.fs` and similar surface helpers (phase 2)
- Adaptify codegen (parallel track)
- Performance tuning beyond "don't allocate gratuitously" (deferred)
