# wombat.adaptive

TypeScript port of `FSharp.Data.Adaptive`. Incremental adaptive computations:
`aval`, `aset`, `amap`, `alist`, with the full combinator surface (`map`,
`bind`, `filter`, `collect`, `union`, `sort`, `pairwise`, `reduce`, etc.).

## Repository origin

Previously published as `@aardworx/adaptive` on npm. Renamed to
`@aardworx/wombat.adaptive` to align with the wombat.* family. The repo
moved from `krauthaufen/adaptive-ts` to `krauthaufen/wombat.adaptive`.

When porting code that imports `@aardworx/adaptive`, update to
`@aardworx/wombat.adaptive` — same surface API, breaking only at the import
specifier.

## Tooling

- `npm test` — vitest, ~250 tests including 500-run property tests for
  every adaptive type, validated against a reference impl in `src/reference/`.
  The reference impl is a literal port of the F# original, used only by the
  property tests as a ground-truth oracle.
- `npm run typecheck` — plain `tsc --noEmit`. No transformers or plugins.
- `npm run build` — emits `dist/` with `.d.ts`, `.js`, source maps.

## Architecture

- `src/core/` — `AdaptiveObject`, transactions, levels, weak-output sets.
  This is the dependency-tracking machinery. Don't touch unless you're
  fixing a fundamental bug — get a second pair of eyes if you do.
- `src/datastructures/` — `HashSet`, `HashMap`, `IndexList`,
  `HashSetDelta`, `HashMapDelta`, `IndexListDelta`. Persistent (not
  incremental themselves), used as values inside aset/amap/alist.
- `src/adaptiveValue/`, `adaptiveHashSet/`, `adaptiveHashMap/`,
  `adaptiveIndexList/` — the four adaptive type families. Each has:
  - the abstract base (`AVal`, `ASet`, …)
  - changeable concrete type (`cval`, `cset`, …)
  - readers (per-output incremental state)
  - combinators (map/bind/filter/etc.)
- `src/reference/` — straight reference impl for property tests. **Don't
  add new features here** unless adding the matching ground-truth for a
  property test.
- `src/extensions/` — bridges between adaptive types (e.g. ASet → AMap).

## Public API barrels

`package.json` exports:
- `.` — full surface
- `./aval`, `./aset`, `./amap`, `./alist` — type-specific
- `./datastructures` — non-adaptive `HashSet`/`HashMap`/`IndexList`
- `./reference` — for tests/oracles
- `./extensions` — bridges

When adding a new public symbol, decide which barrel it belongs to and
update both the corresponding `src/<barrel>.ts` and `src/index.ts`.

## Hashing convention

Uses FNV hash compatible with `@aardworx/wombat.base`. `getHashCode()` on
domain types must return the same value across both packages. If you change
the hash function, both packages need to update in lockstep.

## Equality contract

`equals(other)` and `getHashCode()` together define the equality used by
`HashSet`/`HashMap`. The convention:
- `a.equals(b) === true` ⇒ `a.getHashCode() === b.getHashCode()`
- `equals` accepts `unknown` (returns false on type mismatch)
- `getHashCode` is pure, deterministic, fast

## Don'ts

- Don't import from `src/reference/` in non-test code. Production paths use
  the incremental impl.
- Don't introduce shared mutable state in adaptive object internals — the
  `AdaptiveObject` lifecycle (level, outputs, mark/unmark) assumes single
  consistent transactional updates.
- Don't break the FNV hash convention.
- Don't `npm publish` from a dirty tree. CI runs `prepublishOnly`.
