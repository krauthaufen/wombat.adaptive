# wombat.adaptive — TODO

Status: ✅ stable (0.2.5). Full FSharp.Data.Adaptive port — aval/aset/alist/amap
+ combinators, cross-collection bridges, callbacks, 500-run property tests vs the
F# reference. Feature-complete for its scope; the items below are nice-to-haves.

Architectural / cross-cutting items live in `~/claude/wombat-todo.md`.

## Open

- **`mapUse` / `mapUsei`** — F# `IDisposable`-style mapping; would map to
  `Symbol.dispose` in TS.
- **Adaptify codegen** — separate library that generates adaptive wrappers for
  record types.
- **Tree expansion** — `ASet.ofListTree` / `ASet.ofSetTree`.
