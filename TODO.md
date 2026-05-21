# wombat.adaptive — TODO

Status: ✅ stable (0.2.5). Full FSharp.Data.Adaptive port — aval/aset/alist/amap
+ combinators, cross-collection bridges, callbacks, 500-run property tests vs the
F# reference. Feature-complete for its scope; the items below are nice-to-haves.

Architectural / cross-cutting items live in `~/claude/wombat-todo.md`.

## Open

- **`mapUse` for AList/AMap + `mapUsei`** — `ASet.mapUse` is already implemented
  (refcount-zero dispose callback; `adaptiveHashSet.ts`). Still missing: the
  AList/AMap variants and the indexed `mapUsei`. (Some test comments still claim
  ASet's isn't ported — stale.)
- **Adaptify codegen** — separate library that generates adaptive wrappers for
  record types.
- **Tree expansion** — `ASet.ofListTree` / `ASet.ofSetTree`.
