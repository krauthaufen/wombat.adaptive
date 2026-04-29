// Port of FSharp.Data.Adaptive.Tests/Utilities/Generators.fs
//
// PORT NOTE: the F# original uses FsCheck reflection (`Arb.generate<'a>`,
// `TypeVisitor`) to generate over arbitrary type parameters. We use
// fast-check arbitraries with concrete element types instead — the goal
// is to validate the real adaptive impls against the slow reference
// impls, and for that we just need *some* well-typed expression tree.
//
// PORT NOTE: AMap-related sub-generators (`ofAMap`, `aMapKeys`) and
// AList-related sub-generators (`ofAList`) are stubbed out until phases
// 5 and 6 land their respective real implementations. They are absent
// from the kind frequency tables, not silently dropped — every kind we
// list is fully implemented.

import * as fc from "fast-check";

import {
  type aval as RealAVal,
  cval as realCval,
  type ChangeableValue as RealCVal,
  AVal as RealAValOps,
} from "../../src/adaptiveValue/adaptiveValue.js";
import {
  type aset as RealASet,
  ASet as RealASetOps,
} from "../../src/adaptiveHashSet/adaptiveHashSet.js";
import {
  ChangeableHashSet as RealCSet,
  cset as realCset,
} from "../../src/adaptiveHashSet/changeableHashSet.js";

import {
  AVal as RefAValOps,
  ChangeableValue as RefCVal,
  type aval as RefAVal,
} from "../../src/reference/adaptiveValue.js";
import {
  ASet as RefASetOps,
  ChangeableHashSet as RefCSet,
  type aset as RefASet,
} from "../../src/reference/adaptiveHashSet.js";

import { HashSet, HashMap } from "../../src/datastructures/hashCollections.js";
import { transact } from "../../src/core/transaction.js";

import {
  AMap as RealAMapOps,
  type amap as RealAMap,
} from "../../src/adaptiveHashMap/adaptiveHashMap.js";
import {
  ChangeableHashMap as RealCMap,
  cmap as realCmap,
} from "../../src/adaptiveHashMap/changeableHashMap.js";
import {
  AMap as RefAMapOps,
  ChangeableHashMap as RefCMap,
  type amap as RefAMap,
} from "../../src/reference/adaptiveHashMap.js";
import {
  AMapExt as RealAMapExt,
  SeqExt as RealSeqExt,
} from "../../src/collectionExtensions/collectionExtensions.js";
import { Seq as RefSeq } from "../../src/reference/adaptiveValue.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A change-step for a generator: returns a label after applying. */
export interface ChangeGen {
  /** Identifies the cell (so the test runner can pick a subset). */
  readonly cell: object;
  /** Generator for a parameterless mutator that mirrors real + ref. */
  readonly change: fc.Arbitrary<() => string>;
}

export interface VVal<T> {
  readonly real: RealAVal<T>;
  readonly ref: RefAVal<T>;
  readonly expression: string;
  readonly changes: () => ChangeGen[];
}

export interface VSet<T> {
  readonly sreal: RealASet<T>;
  readonly sref: RefASet<T>;
  readonly sexpression: string;
  readonly schanges: () => ChangeGen[];
}

export interface VMap<K, V> {
  readonly mreal: RealAMap<K, V>;
  readonly mref: RefAMap<K, V>;
  readonly mexpression: string;
  readonly mchanges: () => ChangeGen[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _cidCounter = 0;
const nextCid = () => ++_cidCounter;

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

/**
 * Deterministic "random function" mock keyed by input. Drawn from the
 * generator stream so that the same expression tree always sees the
 * same callbacks, but different runs see fresh ones.
 */
function fnArb<A, B>(
  range: fc.Arbitrary<B>,
): fc.Arbitrary<{ apply: (a: A) => B; cache: Map<unknown, B> }> {
  return fc
    .integer({ min: 0, max: 0x7fffffff })
    .map((seed) => {
      // Use a stable per-fn seed and re-derive per-key via fast-check
      // sampling. We build a per-fn cache lazily and feed it from
      // `range` sampled at a per-key bias.
      const cache = new Map<unknown, B>();
      const apply = (a: A) => {
        const key = a as unknown;
        if (cache.has(key)) return cache.get(key)!;
        // Mix the seed with a hash of the key.
        const keyHash = stringHash(JSON.stringify(a) + ":" + seed);
        const sample = fc.sample(range, {
          numRuns: 1,
          seed: keyHash,
        })[0]!;
        cache.set(key, sample);
        return sample;
      };
      return { apply, cache };
    });
}

function stringHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h | 0) >>> 0;
}

// ---------------------------------------------------------------------------
// Element arbitraries (int domain)
// ---------------------------------------------------------------------------

const arbInt = fc.integer({ min: -8, max: 8 });
const arbHashSet = fc
  .array(arbInt, { maxLength: 6 })
  .map((xs) => HashSet.ofArray(xs));
const arbHashMap = fc
  .array(fc.tuple(arbInt, arbInt), { maxLength: 6 })
  .map((xs) => HashMap.ofArray<number, number>(xs));

// ---------------------------------------------------------------------------
// VVal<int> generators
// ---------------------------------------------------------------------------

function vvalInit(): fc.Arbitrary<VVal<number>> {
  return arbInt.chain((value) => {
    const id = nextCid();
    const real = realCval(value);
    const ref = RefAValOps.init(value);
    return fc.constant({
      real,
      ref,
      expression: `c${id}`,
      changes: () => [
        {
          cell: real,
          change: arbInt.map((newValue) => () => {
            real.value = newValue;
            ref.value = newValue;
            return `C${id} <- ${newValue}`;
          }),
        },
      ],
    } satisfies VVal<number>);
  });
}

function vvalConstant(): fc.Arbitrary<VVal<number>> {
  return arbInt.map((value) => ({
    real: RealAValOps.constant(value),
    ref: RefAValOps.constant(value),
    expression: `v(${value})`,
    changes: () => [],
  }));
}

function vvalMap({ size }: { size: number }): fc.Arbitrary<VVal<number>> {
  return fc.tuple(vvalGen({ size: size - 1 }), fnArb<number, number>(arbInt))
    .map(([v, fn]) => ({
      real: RealAValOps.map(v.real, fn.apply),
      ref: RefAValOps.map(fn.apply, v.ref),
      expression: `map (\n${indent(v.expression)}\n)`,
      changes: v.changes,
    }));
}

function vvalMap2({ size }: { size: number }): fc.Arbitrary<VVal<number>> {
  return fc
    .tuple(
      vvalGen({ size: Math.floor(size / 2) }),
      vvalGen({ size: Math.floor(size / 2) }),
      fnArb<readonly [number, number], number>(arbInt),
    )
    .map(([v1, v2, fn]) => ({
      real: RealAValOps.zip(v1.real, v2.real).map((a, b) => fn.apply([a, b])),
      ref: RefAValOps.map2((a, b) => fn.apply([a, b]), v1.ref, v2.ref),
      expression: `map2 (\n${indent(v1.expression)}\n${indent(v2.expression)}\n)`,
      changes: () => [...v1.changes(), ...v2.changes()],
    }));
}

function vvalBind({ size }: { size: number }): fc.Arbitrary<VVal<number>> {
  // Inner expression is fresh per outer value, so we generate a fresh
  // VVal at lookup time (matching the F# behavior).
  return fc
    .tuple(
      vvalGen({ size: size - 1 }),
      fc.integer({ min: 0, max: 0x7fffffff }),
    )
    .map(([v, seed]) => {
      const innerCache = new Map<number, VVal<number>>();
      let latest: VVal<number> | undefined;
      const mapping = (k: number): VVal<number> => {
        let inner = innerCache.get(k);
        if (inner === undefined) {
          const subSeed = stringHash(seed + ":" + k);
          inner = fc.sample(vvalGen({ size: Math.max(0, size - 2) }), {
            numRuns: 1,
            seed: subSeed,
          })[0]!;
          innerCache.set(k, inner);
        }
        latest = inner;
        return inner;
      };
      return {
        real: RealAValOps.bind(v.real, (a: number) => mapping(a).real),
        ref: RefAValOps.bind((a: number) => mapping(a).ref, v.ref),
        expression: `bind (\n${indent(v.expression)}\n)`,
        changes: () => {
          if (latest === undefined) return v.changes();
          return [...latest.changes(), ...v.changes()];
        },
      };
    });
}

function vvalExistsA(): fc.Arbitrary<VVal<number>> {
  // Build a list of VVal<bool> from a list of booleans plus a few cvals.
  return fc
    .tuple(
      fc.array(vvalBool({ size: 0 }), { minLength: 1, maxLength: 5 }),
      arbInt,
      arbInt,
    )
    .map(([vbools, t, f]) => {
      const map = (b: boolean) => (b ? t : f);
      const real = RealAValOps.map(
        RealSeqExt.existsA((v) => v.real, vbools),
        map,
      );
      const ref = RefAValOps.map(
        map,
        RefSeq.existsA((v) => v.ref, vbools),
      );
      return {
        real,
        ref,
        expression: `existsA (${vbools.length})`,
        changes: () => vbools.flatMap((v) => v.changes()),
      } satisfies VVal<number>;
    });
}

function vvalForallA(): fc.Arbitrary<VVal<number>> {
  return fc
    .tuple(
      fc.array(vvalBool({ size: 0 }), { minLength: 1, maxLength: 5 }),
      arbInt,
      arbInt,
    )
    .map(([vbools, t, f]) => {
      const map = (b: boolean) => (b ? t : f);
      const real = RealAValOps.map(
        RealSeqExt.forallA((v) => v.real, vbools),
        map,
      );
      const ref = RefAValOps.map(
        map,
        RefSeq.forallA((v) => v.ref, vbools),
      );
      return {
        real,
        ref,
        expression: `forallA (${vbools.length})`,
        changes: () => vbools.flatMap((v) => v.changes()),
      } satisfies VVal<number>;
    });
}

/**
 * Boolean-valued VVal — used as the inner predicate value for
 * existsA/forallA. We just lift a cval<bool> via init+map.
 */
function vvalBool({ size }: { size: number }): fc.Arbitrary<VVal<boolean>> {
  void size;
  return fc.boolean().chain((b) => {
    const id = nextCid();
    const real = realCval(b);
    const ref = RefAValOps.init(b);
    return fc.constant({
      real,
      ref,
      expression: `b${id}`,
      changes: () => [
        {
          cell: real,
          change: fc.boolean().map((nv) => () => {
            real.value = nv;
            ref.value = nv;
            return `B${id} <- ${nv}`;
          }),
        },
      ],
    } satisfies VVal<boolean>);
  });
}

function vvalGen({ size }: { size: number }): fc.Arbitrary<VVal<number>> {
  if (size <= 0) {
    return fc.oneof(
      { arbitrary: vvalConstant(), weight: 1 },
      { arbitrary: vvalInit(), weight: 5 },
    );
  }
  return fc.oneof(
    { arbitrary: vvalConstant(), weight: 1 },
    { arbitrary: vvalInit(), weight: 5 },
    { arbitrary: vvalMap({ size }), weight: 5 },
    { arbitrary: vvalMap2({ size }), weight: 5 },
    { arbitrary: vvalBind({ size }), weight: 3 },
    { arbitrary: vvalExistsA(), weight: 3 },
    { arbitrary: vvalForallA(), weight: 3 },
  );
}

// ---------------------------------------------------------------------------
// VSet<int> generators
// ---------------------------------------------------------------------------

function vsetInit(): fc.Arbitrary<VSet<number>> {
  return arbHashSet.chain((value) => {
    const id = nextCid();
    const real = realCset<number>(value);
    const ref = new RefCSet<number>(value);
    return fc.constant({
      sreal: real,
      sref: ref,
      sexpression: `c${id}`,
      schanges: () => [
        {
          cell: real,
          change: arbHashSet.map((nv) => () => {
            real.value = nv;
            ref.value = nv;
            return `C${id} <- ${[...nv].join(",")}`;
          }),
        },
      ],
    } satisfies VSet<number>);
  });
}

function vsetConstant(): fc.Arbitrary<VSet<number>> {
  return arbHashSet.map((v) => ({
    sreal: RealASetOps.ofHashSet(v),
    sref: RefASetOps.ofHashSet(v),
    sexpression: `const(${[...v].join(",")})`,
    schanges: () => [],
  }));
}

function vsetMap({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  return fc
    .tuple(vsetGen({ size: size - 2 }), fnArb<number, number>(arbInt))
    .map(([v, fn]) => ({
      sreal: RealASetOps.map(fn.apply, v.sreal),
      sref: RefASetOps.map(fn.apply, v.sref),
      sexpression: `map (\n${indent(v.sexpression)}\n)`,
      schanges: v.schanges,
    }));
}

function vsetChoose({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  return fc
    .tuple(
      vsetGen({ size: size - 2 }),
      fnArb<number, number | undefined>(
        fc.option(arbInt, { nil: undefined, freq: 3 }),
      ),
    )
    .map(([v, fn]) => ({
      sreal: RealASetOps.choose(fn.apply, v.sreal),
      sref: RefASetOps.choose(fn.apply, v.sref),
      sexpression: `choose (\n${indent(v.sexpression)}\n)`,
      schanges: v.schanges,
    }));
}

function vsetFilter({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  return fc
    .tuple(vsetGen({ size: size - 2 }), fnArb<number, boolean>(fc.boolean()))
    .map(([v, fn]) => ({
      sreal: RealASetOps.filter(fn.apply, v.sreal),
      sref: RefASetOps.filter(fn.apply, v.sref),
      sexpression: `filter (\n${indent(v.sexpression)}\n)`,
      schanges: v.schanges,
    }));
}

function vsetUnion({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  const half = Math.floor(size / 2);
  return fc.tuple(vsetGen({ size: half }), vsetGen({ size: half })).map(
    ([a, b]) => ({
      sreal: RealASetOps.union(a.sreal, b.sreal),
      sref: RefASetOps.union(a.sref, b.sref),
      sexpression: `union\n${indent(a.sexpression)}\n${indent(b.sexpression)}`,
      schanges: () => [...a.schanges(), ...b.schanges()],
    }),
  );
}

function vsetIntersect({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  const half = Math.floor(size / 2);
  return fc.tuple(vsetGen({ size: half }), vsetGen({ size: half })).map(
    ([a, b]) => ({
      sreal: RealASetOps.intersect(a.sreal, b.sreal),
      sref: RefASetOps.intersect(a.sref, b.sref),
      sexpression: `intersect\n${indent(a.sexpression)}\n${indent(b.sexpression)}`,
      schanges: () => [...a.schanges(), ...b.schanges()],
    }),
  );
}

function vsetDifference({
  size,
}: {
  size: number;
}): fc.Arbitrary<VSet<number>> {
  const half = Math.floor(size / 2);
  return fc.tuple(vsetGen({ size: half }), vsetGen({ size: half })).map(
    ([a, b]) => ({
      sreal: RealASetOps.difference(a.sreal, b.sreal),
      sref: RefASetOps.difference(a.sref, b.sref),
      sexpression: `difference\n${indent(a.sexpression)}\n${indent(b.sexpression)}`,
      schanges: () => [...a.schanges(), ...b.schanges()],
    }),
  );
}

function vsetXor({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  const half = Math.floor(size / 2);
  return fc.tuple(vsetGen({ size: half }), vsetGen({ size: half })).map(
    ([a, b]) => ({
      sreal: RealASetOps.xor(a.sreal, b.sreal),
      sref: RefASetOps.xor(a.sref, b.sref),
      sexpression: `xor\n${indent(a.sexpression)}\n${indent(b.sexpression)}`,
      schanges: () => [...a.schanges(), ...b.schanges()],
    }),
  );
}

function vsetUnionMany({
  size,
}: {
  size: number;
}): fc.Arbitrary<VSet<number>> {
  const inner = size <= 1 ? 0 : Math.floor(Math.sqrt(size));
  // outer set of sets — take a small fixed-size array
  return fc
    .array(vsetGen({ size: inner }), { minLength: 0, maxLength: 4 })
    .map((arr) => {
      const sreals = arr.map((v) => v.sreal);
      const srefs = arr.map((v) => v.sref);
      const realOuter = RealASetOps.ofList(sreals);
      const refOuter = RefASetOps.ofList(srefs);
      return {
        sreal: RealASetOps.unionMany(realOuter),
        sref: RefASetOps.unionMany(refOuter),
        sexpression: `unionMany [\n${arr.map((a) => indent(a.sexpression)).join("\n")}\n]`,
        schanges: () => arr.flatMap((a) => a.schanges()),
      };
    });
}

function vsetOfAVal({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  void size;
  // VVal<HashSet<int>> — derived from a VVal<int> via a degenerate
  // constant lift: simpler is to start from a cval<HashSet<int>>.
  return arbHashSet.chain((initial) => {
    const id = nextCid();
    const real = realCval(initial);
    const ref = RefAValOps.init(initial);
    const change: ChangeGen = {
      cell: real,
      change: arbHashSet.map((nv) => () => {
        real.value = nv;
        ref.value = nv;
        return `C${id} <- ofAVal[${[...nv].join(",")}]`;
      }),
    };
    return fc.constant({
      sreal: RealASetOps.ofAVal(real),
      sref: RefASetOps.ofAVal(ref),
      sexpression: `ofAVal(c${id})`,
      schanges: () => [change],
    } satisfies VSet<number>);
  });
}

function vsetBind({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  return fc
    .tuple(
      vvalGen({ size: 0 }),
      fc.integer({ min: 0, max: 0x7fffffff }),
    )
    .map(([v, seed]) => {
      const cache = new Map<number, VSet<number>>();
      let latest: VSet<number> | undefined;
      const mapping = (k: number): VSet<number> => {
        let inner = cache.get(k);
        if (inner === undefined) {
          const subSeed = stringHash(seed + ":" + k);
          inner = fc.sample(vsetGen({ size: Math.max(0, size - 1) }), {
            numRuns: 1,
            seed: subSeed,
          })[0]!;
          cache.set(k, inner);
        }
        latest = inner;
        return inner;
      };
      return {
        sreal: RealASetOps.bind((a: number) => mapping(a).sreal, v.real),
        sref: RefASetOps.bind((a: number) => mapping(a).sref, v.ref),
        sexpression: `bind (\n${indent(v.expression)}\n)`,
        schanges: () => {
          if (latest === undefined) return v.changes();
          return [...latest.schanges(), ...v.changes()];
        },
      };
    });
}

function vsetCollect({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  const innerSize = size > 0 ? Math.floor(Math.sqrt(size)) : 0;
  return fc
    .tuple(
      vsetGen({ size: size - 1 }),
      fc.integer({ min: 0, max: 0x7fffffff }),
    )
    .map(([v, seed]) => {
      const cache = new Map<number, VSet<number>>();
      const mapping = (k: number): VSet<number> => {
        let inner = cache.get(k);
        if (inner === undefined) {
          const subSeed = stringHash(seed + ":" + k);
          inner = fc.sample(vsetGen({ size: innerSize }), {
            numRuns: 1,
            seed: subSeed,
          })[0]!;
          cache.set(k, inner);
        }
        return inner;
      };
      return {
        sreal: RealASetOps.collect((a: number) => mapping(a).sreal, v.sreal),
        sref: RefASetOps.collect((a: number) => mapping(a).sref, v.sref),
        sexpression: `collect (\n${indent(v.sexpression)}\n)`,
        schanges: () => {
          // Walk the *current* reference content and harvest changes
          // from each materialized inner.
          const cur = RefAValOps.force(v.sref.content);
          const innerChanges: ChangeGen[] = [];
          for (const k of cur) innerChanges.push(...mapping(k).schanges());
          return [...v.schanges(), ...innerChanges];
        },
      };
    });
}

function vsetOfAMap({
  size,
}: {
  size: number;
}): fc.Arbitrary<VSet<number>> {
  // Take a VMap<int,int>, project to the *value* set as
  // `aset<int>` for both real and reference. We use a constant
  // wrapper since the F# generator restricts inner size to 0 to keep
  // the expression bounded.
  return arbVMap({ size: 0 }).map((m) => ({
    sreal: RealASetOps.map(
      (kv) => kv.value,
      RealAMapOps.toASet(m.mreal),
    ),
    sref: RefASetOps.map((kv) => kv[1], RefAMapOps.toASet(m.mref)),
    sexpression: `ofAMap (\n${indent(m.mexpression)}\n)`,
    schanges: m.mchanges,
  }));
}

function vsetAMapKeys({
  size,
}: {
  size: number;
}): fc.Arbitrary<VSet<number>> {
  return arbVMap({ size: 0 }).map((m) => ({
    sreal: RealAMapExt.keys(m.mreal),
    // Reference doesn't expose `.keys`; project via toASet+map(fst).
    sref: RefASetOps.map((kv) => kv[0], RefAMapOps.toASet(m.mref)),
    sexpression: `aMapKeys (\n${indent(m.mexpression)}\n)`,
    schanges: m.mchanges,
  }));
}

export function vsetGen({ size }: { size: number }): fc.Arbitrary<VSet<number>> {
  if (size <= 0) {
    return fc.oneof(
      { arbitrary: vsetConstant(), weight: 1 },
      { arbitrary: vsetInit(), weight: 5 },
    );
  }
  return fc.oneof(
    { arbitrary: vsetConstant(), weight: 1 },
    { arbitrary: vsetInit(), weight: 3 },
    { arbitrary: vsetMap({ size }), weight: 3 },
    { arbitrary: vsetChoose({ size }), weight: 3 },
    { arbitrary: vsetFilter({ size }), weight: 3 },
    { arbitrary: vsetUnion({ size }), weight: 3 },
    { arbitrary: vsetIntersect({ size }), weight: 3 },
    { arbitrary: vsetDifference({ size }), weight: 3 },
    { arbitrary: vsetXor({ size }), weight: 3 },
    { arbitrary: vsetUnionMany({ size }), weight: 1 },
    { arbitrary: vsetOfAVal({ size }), weight: 1 },
    { arbitrary: vsetBind({ size }), weight: 1 },
    { arbitrary: vsetCollect({ size }), weight: 2 },
    { arbitrary: vsetOfAMap({ size }), weight: 2 },
    { arbitrary: vsetAMapKeys({ size }), weight: 2 },
  );
}

/** Top-level VSet generator at a given size. */
export const arbVSet = vsetGen;

/** Top-level VVal generator at a given size. */
export const arbVVal = vvalGen;

// ---------------------------------------------------------------------------
// VMap<int, int> generators
// ---------------------------------------------------------------------------

function vmapInit(): fc.Arbitrary<VMap<number, number>> {
  return arbHashMap.chain((value) => {
    const id = nextCid();
    const real = realCmap<number, number>(value);
    const ref = new RefCMap<number, number>(value);
    return fc.constant({
      mreal: real,
      mref: ref,
      mexpression: `c${id}`,
      mchanges: () => [
        {
          cell: real,
          change: arbHashMap.map((nv) => () => {
            real.value = nv;
            ref.value = nv;
            return `C${id} <- ${[...nv].map(([k, v]) => `${k}=>${v}`).join(",")}`;
          }),
        },
      ],
    } satisfies VMap<number, number>);
  });
}

function vmapConstant(): fc.Arbitrary<VMap<number, number>> {
  return arbHashMap.map((v) => ({
    mreal: RealAMapOps.ofHashMap(v),
    mref: RefAMapOps.ofHashMap(v),
    mexpression: `const(${[...v].length})`,
    mchanges: () => [],
  }));
}

function vmapMap({ size }: { size: number }): fc.Arbitrary<VMap<number, number>> {
  return fc
    .tuple(
      vmapGen({ size: size - 2 }),
      fnArb<readonly [number, number], number>(arbInt),
    )
    .map(([m, fn]) => ({
      mreal: RealAMapOps.map((k, v) => fn.apply([k, v]), m.mreal),
      mref: RefAMapOps.map((k, v) => fn.apply([k, v]), m.mref),
      mexpression: `map (\n${indent(m.mexpression)}\n)`,
      mchanges: m.mchanges,
    }));
}

function vmapMapValue({
  size,
}: {
  size: number;
}): fc.Arbitrary<VMap<number, number>> {
  return fc
    .tuple(vmapGen({ size: size - 2 }), fnArb<number, number>(arbInt))
    .map(([m, fn]) => ({
      mreal: RealAMapOps.mapValue(fn.apply, m.mreal),
      mref: RefAMapOps.mapValue(fn.apply, m.mref),
      mexpression: `map' (\n${indent(m.mexpression)}\n)`,
      mchanges: m.mchanges,
    }));
}

function vmapChoose({ size }: { size: number }): fc.Arbitrary<VMap<number, number>> {
  return fc
    .tuple(
      vmapGen({ size: size - 2 }),
      fnArb<readonly [number, number], number | undefined>(
        fc.option(arbInt, { nil: undefined, freq: 3 }),
      ),
    )
    .map(([m, fn]) => ({
      mreal: RealAMapOps.choose((k, v) => fn.apply([k, v]), m.mreal),
      mref: RefAMapOps.choose((k, v) => fn.apply([k, v]), m.mref),
      mexpression: `choose (\n${indent(m.mexpression)}\n)`,
      mchanges: m.mchanges,
    }));
}

function vmapFilter({
  size,
}: {
  size: number;
}): fc.Arbitrary<VMap<number, number>> {
  return fc
    .tuple(
      vmapGen({ size: size - 2 }),
      fnArb<readonly [number, number], boolean>(fc.boolean()),
    )
    .map(([m, fn]) => ({
      mreal: RealAMapOps.filter((k, v) => fn.apply([k, v]), m.mreal),
      mref: RefAMapOps.filter((k, v) => fn.apply([k, v]), m.mref),
      mexpression: `filter (\n${indent(m.mexpression)}\n)`,
      mchanges: m.mchanges,
    }));
}

function vmapUnion({
  size,
}: {
  size: number;
}): fc.Arbitrary<VMap<number, number>> {
  const half = Math.floor(size / 2);
  return fc.tuple(vmapGen({ size: half }), vmapGen({ size: half })).map(
    ([a, b]) => ({
      mreal: RealAMapOps.union(a.mreal, b.mreal),
      mref: RefAMapOps.union(a.mref, b.mref),
      mexpression: `union\n${indent(a.mexpression)}\n${indent(b.mexpression)}`,
      mchanges: () => [...a.mchanges(), ...b.mchanges()],
    }),
  );
}

function vmapMapSet({
  size,
}: {
  size: number;
}): fc.Arbitrary<VMap<number, number>> {
  return fc
    .tuple(arbVSet({ size }), fnArb<number, number>(arbInt))
    .map(([s, fn]) => ({
      mreal: RealAMapOps.mapSet(fn.apply, s.sreal),
      mref: RefAMapOps.mapSet(fn.apply, s.sref),
      mexpression: `mapSet (\n${indent(s.sexpression)}\n)`,
      mchanges: s.schanges,
    }));
}

function vmapBind({ size }: { size: number }): fc.Arbitrary<VMap<number, number>> {
  return fc
    .tuple(
      vvalGen({ size: 0 }),
      fc.integer({ min: 0, max: 0x7fffffff }),
    )
    .map(([v, seed]) => {
      const cache = new Map<number, VMap<number, number>>();
      let latest: VMap<number, number> | undefined;
      const mapping = (k: number): VMap<number, number> => {
        let inner = cache.get(k);
        if (inner === undefined) {
          const subSeed = stringHash(seed + ":" + k);
          inner = fc.sample(vmapGen({ size: Math.max(0, size - 1) }), {
            numRuns: 1,
            seed: subSeed,
          })[0]!;
          cache.set(k, inner);
        }
        latest = inner;
        return inner;
      };
      return {
        mreal: RealAMapOps.bind((a: number) => mapping(a).mreal, v.real),
        mref: RefAMapOps.bind((a: number) => mapping(a).mref, v.ref),
        mexpression: `bind (\n${indent(v.expression)}\n)`,
        mchanges: () => {
          if (latest === undefined) return v.changes();
          return [...latest.mchanges(), ...v.changes()];
        },
      };
    });
}

export function vmapGen({
  size,
}: {
  size: number;
}): fc.Arbitrary<VMap<number, number>> {
  if (size <= 0) {
    return fc.oneof(
      { arbitrary: vmapConstant(), weight: 1 },
      { arbitrary: vmapInit(), weight: 5 },
    );
  }
  return fc.oneof(
    { arbitrary: vmapConstant(), weight: 1 },
    { arbitrary: vmapInit(), weight: 3 },
    { arbitrary: vmapMap({ size }), weight: 3 },
    { arbitrary: vmapMapValue({ size }), weight: 3 },
    { arbitrary: vmapChoose({ size }), weight: 3 },
    { arbitrary: vmapFilter({ size }), weight: 3 },
    { arbitrary: vmapUnion({ size }), weight: 3 },
    { arbitrary: vmapMapSet({ size }), weight: 2 },
    { arbitrary: vmapBind({ size }), weight: 1 },
  );
}

/** Top-level VMap generator at a given size. */
export const arbVMap = vmapGen;

// Avoid "unused" complaints from imports we keep in the API surface.
void RealCSet;
void RefCVal;
type _RealCValAlias<T> = RealCVal<T>;
void undefined as unknown as _RealCValAlias<number>;
void transact;
