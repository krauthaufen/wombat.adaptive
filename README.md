# @aardworx/wombat.adaptive

TypeScript port of [FSharp.Data.Adaptive](https://github.com/aardvark-platform/aardvark.docs/wiki/FSharp.Data.Adaptive). Incremental adaptive computations: `aval` (changeable values), `aset` (changeable sets), `amap` (changeable maps), `alist` (changeable lists), with all the combinators (`map` / `bind` / `filter` / `collect` / `union` / `sort` / `pairwise` / `reduce` / …).

The implementation is a faithful port of the F# original — same algorithms, same incremental update semantics, validated against the F# reference impl by 500-run property tests for each adaptive type.

## Install

```bash
npm install @aardworx/wombat.adaptive
```

ESM only. Node ≥ 18, modern bundlers (Vite, esbuild, webpack 5+).

## Quick start

```ts
import { cval, AVal, cset, ASet, transact } from "@aardworx/wombat.adaptive";

const x = cval(1);
const y = cval(2);
const sum = AVal.zip(x, y).map((a, b) => a + b);

console.log(AVal.force(sum)); // 3

transact(() => {
  x.value = 10;
  y.value = 20;
});
console.log(AVal.force(sum)); // 30

const s = cset<number>([1, 2, 3]);
const doubled = ASet.map((n) => n * 2, s);
console.log([...AVal.force(doubled.content)].sort()); // [2, 4, 6]

transact(() => s.add(4));
console.log([...AVal.force(doubled.content)].sort()); // [2, 4, 6, 8]
```

## Module map

The package ships fine-grained sub-paths that all tree-shake well. Pick whichever feels cleaner:

| Sub-path | What it exports |
| --- | --- |
| `@aardworx/wombat.adaptive` | Curated public surface — most consumers import from here |
| `@aardworx/wombat.adaptive/aval` | `AVal`, `cval`, `aval`, `Reductions` |
| `@aardworx/wombat.adaptive/aset` | `ASet`, `cset`, `aset` |
| `@aardworx/wombat.adaptive/amap` | `AMap`, `cmap`, `amap`, `KeyValuePair` |
| `@aardworx/wombat.adaptive/alist` | `AList`, `clist`, `alist` |
| `@aardworx/wombat.adaptive/datastructures` | `HashSet`, `HashMap`, `IndexList`, `Index`, `MapExt`, deltas |
| `@aardworx/wombat.adaptive/extensions` | Cross-collection bridges + `addCallback` for collections |
| `@aardworx/wombat.adaptive/traceable` | Low-level `History` / readers (extension authors) |
| `@aardworx/wombat.adaptive/reference` | Slow-but-correct executable spec for property testing |

```ts
// fine-grained
import { ASet, cset } from "@aardworx/wombat.adaptive/aset";
import { HashSet } from "@aardworx/wombat.adaptive/datastructures";
import { AListBridges } from "@aardworx/wombat.adaptive/extensions";
```

## Listening to changes

`addCallback` fires once on subscription with the empty-to-current
delta, then on each transaction when the underlying reader has new
changes. Mirrors F#'s `EvaluationCallbackExtensions`.

```ts
import { cset, asetCallback, transact } from "@aardworx/wombat.adaptive";

const s = cset<number>([1, 2]);
const sub = asetCallback(s, (state, delta) => {
  console.log("size before:", state.count, "delta size:", delta.count);
});

transact(() => s.add(3));    // logs "size before: 2 delta size: 1"
transact(() => s.remove(1)); // logs "size before: 3 delta size: 1"
sub.dispose();
```

## What's incremental

Every combinator in the public surface is genuinely incremental — applying a delta of size *k* against a state of size *N* costs O(*k*), not O(*N*), unless *k* ≥ *N* (where bulk recompute wins). This includes:

- `reduce` / `reduceBy` / `reduceByA` and everything derived from them: `sum`, `sumBy`, `sumByA`, `average`, `averageBy`, `fold`, `foldGroup`, `foldHalfGroup`, `forall`, `exists`, `forallA`, `existsA`, `countBy`, `countByA`, `tryMin`, `tryMax`
- `contains` (refcount-tracked single-value membership)
- `map` / `choose` / `filter` / `collect` / `union` / `intersect` / `difference` / `xor` / `bind` and their `*A` variants
- `AList.range` / `AList.subA` / `AList.takeA` / `AList.skipA` (four-region delta merge for shifting integer ranges; overlapping-window delta for slices)

## Equality

`@aardworx/wombat.adaptive` honours the same `equals(other)` / `getHashCode()` convention as F#: any object that defines both methods is hashed and compared structurally throughout the library (HashSet keys, HashMap keys, Cache keys, Index identity, etc.). Primitives use `Object.is` + a type-aware hash.

```ts
import { HashSet } from "@aardworx/wombat.adaptive/datastructures";

class Pair {
  constructor(readonly a: number, readonly b: number) {}
  equals(o: unknown): boolean {
    return o instanceof Pair && o.a === this.a && o.b === this.b;
  }
  getHashCode(): number {
    return ((this.a | 0) * 31 + (this.b | 0)) | 0;
  }
}

const s = HashSet.empty<Pair>().add(new Pair(1, 2)).add(new Pair(1, 2));
s.count; // 1
```

## Status

- ✅ Full port of `aval` / `aset` / `amap` / `alist` and combinators
- ✅ Cross-collection bridges (ASet ↔ AList ↔ AMap)
- ✅ Callbacks with state+delta payloads
- ✅ Reference impl + 500-run property tests for AVal / ASet / AMap / AList
- ⏭️ `mapUse` / `mapUsei` (F# uses `IDisposable`; would map to `Symbol.dispose`)
- ⏭️ `Adaptify` codegen (separate library)
- ⏭️ Tree expansion: `ASet.ofListTree` / `ASet.ofSetTree`

## Build & test

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emit to dist/
```

## License

MIT — derived from FSharp.Data.Adaptive (© Aardvark Platform).
