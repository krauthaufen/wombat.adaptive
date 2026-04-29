// Test ports for HashMap / HashSet / HashSetDelta / HashMapDelta. Subset
// of FSharp.Data.Adaptive.Tests/HashMap.fs and HashSet.fs covering the
// public API. Property tests use fast-check against a JS Map oracle.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { HashMap, HashSet } from "../src/datastructures/hashCollections.js";
import { HashSetDelta } from "../src/datastructures/hashSetDelta.js";
import { HashMapDelta } from "../src/datastructures/hashMapDelta.js";
import {
  ElementRemove,
  ElementSet,
  SetOperation,
} from "../src/datastructures/operations.js";
import {
  HashMapDeltaExt,
  HashSetDeltaExt,
} from "../src/datastructures/deltas.js";
import type { IEqualityComparer } from "../src/datastructures/equality.js";

const arbMap = fc.dictionary(fc.string(), fc.integer());
const arbSet = fc.array(fc.integer(), { maxLength: 200 });
const arbIntMap = fc.array(
  fc.tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer()),
  { maxLength: 100 },
);

const sortByKey = <K, V>(arr: Array<[K, V]>): Array<[K, V]> =>
  [...arr].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));

/// A deliberately-bad hash: only two buckets (`value & 1`). Used to
/// exercise the HAMT collision-chain code paths.
class StupidHash {
  constructor(public readonly value: number) {}
}
const stupidHashCmp: IEqualityComparer<StupidHash> = {
  equals: (a, b) => a.value === b.value,
  hash: (a) => Math.abs(a.value) % 2,
};
const arbStupidHash = fc.integer({ min: -100, max: 100 }).map((v) => new StupidHash(v));

describe("HashMap basics", () => {
  test("empty / count / isEmpty", () => {
    const m = HashMap.empty<string, number>();
    expect(m.count).toBe(0);
    expect(m.isEmpty).toBe(true);
  });

  test("add / containsKey / tryFind / remove", () => {
    let m = HashMap.empty<string, number>();
    m = m.add("a", 1).add("b", 2).add("a", 11);
    expect(m.count).toBe(2);
    expect(m.tryFind("a")).toBe(11);
    expect(m.tryFind("b")).toBe(2);
    expect(m.tryFind("c")).toBeUndefined();
    expect(m.containsKey("a")).toBe(true);
    expect(m.containsKey("c")).toBe(false);
    m = m.remove("a");
    expect(m.containsKey("a")).toBe(false);
    expect(m.count).toBe(1);
  });

  test("add returns a new HashMap (immutability)", () => {
    const a = HashMap.single("x", 1);
    const b = a.add("y", 2);
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
    expect(a.tryFind("y")).toBeUndefined();
    expect(b.tryFind("y")).toBe(2);
  });

  test("alter — insert, update, remove via callback", () => {
    let m = HashMap.empty<string, number>();
    m = m.alter("a", () => 1);
    m = m.alter("a", (v) => (v ?? 0) + 10);
    expect(m.tryFind("a")).toBe(11);
    m = m.alter("a", () => undefined);
    expect(m.containsKey("a")).toBe(false);
  });

  test("ofSeq / ofArray / ofList", () => {
    const m = HashMap.ofArray<string, number>([["a", 1], ["b", 2]]);
    expect(m.count).toBe(2);
    expect(m.tryFind("b")).toBe(2);
  });

  test("union / intersect / filter / choose / map / fold", () => {
    const a = HashMap.ofArray<string, number>([["a", 1], ["b", 2]]);
    const b = HashMap.ofArray<string, number>([["b", 20], ["c", 3]]);
    const u = a.unionWith(b);
    expect(u.count).toBe(3);
    expect(u.tryFind("b")).toBe(20); // right wins by default

    const ix = a.intersect(b);
    expect(ix.count).toBe(1);
    expect(ix.tryFind("b")).toEqual([2, 20]);

    const evens = a.filter((_k, v) => v % 2 === 0);
    expect(evens.count).toBe(1);
    expect(evens.tryFind("b")).toBe(2);

    const doubled = a.map((_k, v) => v * 2);
    expect(doubled.tryFind("a")).toBe(2);

    const total = a.fold((s, _k, v) => s + v, 0);
    expect(total).toBe(3);
  });

  test("equals", () => {
    const a = HashMap.ofArray<string, number>([["a", 1], ["b", 2]]);
    const b = HashMap.ofArray<string, number>([["b", 2], ["a", 1]]);
    expect(a.equals(b)).toBe(true);
  });

  test("property: HashMap.ofList agrees with JS Map on (sorted) entries", () => {
    fc.assert(
      fc.property(arbIntMap, (entries) => {
        const m = HashMap.ofArray<number, number>(entries);
        // JS Map dedupe (last-wins to match HashMap semantics).
        const ref = new Map<number, number>();
        for (const [k, v] of entries) ref.set(k, v);
        expect(m.count).toBe(ref.size);
        for (const [k, v] of ref) expect(m.tryFind(k)).toBe(v);
      }),
    );
  });

  test("property: count invariants from F# test", () => {
    fc.assert(
      fc.property(arbMap, fc.string(), (l, a) => {
        // skip if a is in l (matches F# `not (Map.containsKey a l)` constraint)
        if (a in l) return;
        const map = HashMap.ofArray(Object.entries(l));
        const mapWithA = map.add(a, 0);
        expect(HashMap.empty().count).toBe(0);
        expect(mapWithA.count).toBe(map.count + 1);
        expect(mapWithA.remove(a).count).toBe(map.count);
        expect(map.unionWith(map).count).toBe(map.count);
        expect(map.map((_k, v) => v).count).toBe(map.count);
        expect(map.filter(() => true).count).toBe(map.count);
        expect(map.filter(() => false).count).toBe(0);
        expect(map.choose((_k, v) => v).count).toBe(map.count);
        expect(map.choose(() => undefined).count).toBe(0);
        expect(mapWithA.alter(a, () => undefined).count).toBe(map.count);
        expect(mapWithA.alter(a, () => 5).count).toBe(mapWithA.count);
      }),
    );
  });
});

describe("HashSet basics", () => {
  test("empty / single / count / contains", () => {
    expect(HashSet.empty().count).toBe(0);
    const s = HashSet.single(1).add(2).add(2).add(3);
    expect(s.count).toBe(3);
    expect(s.contains(2)).toBe(true);
    expect(s.contains(99)).toBe(false);
  });

  test("ofSeq / toArray", () => {
    const s = HashSet.ofArray([1, 2, 2, 3, 3, 3, 4]);
    expect(s.count).toBe(4);
    expect([...s].sort()).toEqual([1, 2, 3, 4]);
  });

  test("union / intersect / xor / difference", () => {
    const a = HashSet.ofArray([1, 2, 3]);
    const b = HashSet.ofArray([3, 4, 5]);
    expect([...a.unionWith(b)].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...a.intersectWith(b)].sort()).toEqual([3]);
    expect([...a.symmetricExceptWith(b)].sort()).toEqual([1, 2, 4, 5]);
    expect([...a.exceptWith(b)].sort()).toEqual([1, 2]);
  });

  test("setEquals / overlaps / subset", () => {
    const a = HashSet.ofArray([1, 2, 3]);
    const b = HashSet.ofArray([3, 2, 1]);
    expect(a.setEquals(b)).toBe(true);
    expect(a.overlaps(HashSet.single(2))).toBe(true);
    expect(a.overlaps(HashSet.single(99))).toBe(false);
    expect(HashSet.single(2).isSubsetOf(a)).toBe(true);
    expect(a.isSubsetOf(HashSet.single(2))).toBe(false);
  });

  test("property: union/intersect/difference behave like Set<int>", () => {
    fc.assert(
      fc.property(arbSet, arbSet, (l, r) => {
        const a = HashSet.ofArray(l);
        const b = HashSet.ofArray(r);
        const refA = new Set(l);
        const refB = new Set(r);

        const refUnion = new Set([...refA, ...refB]);
        const refInter = new Set([...refA].filter((x) => refB.has(x)));
        const refDiff = new Set([...refA].filter((x) => !refB.has(x)));

        expect(a.unionWith(b).count).toBe(refUnion.size);
        expect(a.intersectWith(b).count).toBe(refInter.size);
        expect(a.exceptWith(b).count).toBe(refDiff.size);
      }),
    );
  });
});

describe("HashSetDelta", () => {
  test("add / combine / inverse cancellation", () => {
    const d1 = HashSetDelta.ofArray([SetOperation.add(1), SetOperation.add(2)]);
    const d2 = HashSetDelta.ofArray([SetOperation.rem(1)]);
    const c = d1.combine(d2);
    expect(c.count).toBe(1);
    expect([...c]).toEqual([new SetOperation(2, 1)]);
  });

  test("inverse / map / filter / collect", () => {
    const d = HashSetDelta.ofArray([SetOperation.add(1), SetOperation.add(2)]);
    const inv = d.inverse;
    expect([...inv].map((op) => op.count)).toEqual([-1, -1]);

    const mapped = d.map((op) => new SetOperation(op.value * 10, op.count));
    expect([...mapped].map((op) => op.value).sort()).toEqual([10, 20]);

    const filtered = d.filter((op) => op.value === 1);
    expect(filtered.count).toBe(1);

    const collected = d.collect((op) =>
      HashSetDelta.ofArray([SetOperation.add(op.value), SetOperation.add(op.value + 100)]),
    );
    expect(collected.count).toBe(4);
  });
});

describe("HashMapDelta", () => {
  test("combine / single / iteration", () => {
    const d1 = HashMapDelta.ofArray<string, number>([["a", ElementSet(1)]]);
    const d2 = HashMapDelta.ofArray<string, number>([["b", ElementRemove]]);
    const c = d1.combine(d2);
    expect(c.count).toBe(2);
  });
});

describe("HashSet.applyDelta / computeDelta", () => {
  test("applyDelta(empty, {Rem 1}) = (empty, {})", () => {
    const r = HashSetDeltaExt.applyDelta(
      HashSet.empty<number>(),
      HashSetDelta.ofArray([SetOperation.rem(1)]),
    );
    expect(r.state.isEmpty).toBe(true);
    expect(r.delta.isEmpty).toBe(true);
  });

  test("applyDelta({1}, {Add 1}) = ({1}, {})", () => {
    const r = HashSetDeltaExt.applyDelta(
      HashSet.single(1),
      HashSetDelta.ofArray([SetOperation.add(1)]),
    );
    expect(r.state.setEquals(HashSet.single(1))).toBe(true);
    expect(r.delta.isEmpty).toBe(true);
  });

  test("computeDelta(A, A) is empty", () => {
    fc.assert(
      fc.property(arbSet, (l) => {
        const a = HashSet.ofArray(l);
        const d = HashSetDeltaExt.computeDelta(a, a);
        expect(d.isEmpty).toBe(true);
      }),
    );
  });

  test("applyDelta(A, computeDelta(A, B)) = (B, computeDelta(A, B))", () => {
    fc.assert(
      fc.property(arbSet, arbSet, (l, r) => {
        const a = HashSet.ofArray(l);
        const b = HashSet.ofArray(r);
        const d = HashSetDeltaExt.computeDelta(a, b);
        const out = HashSetDeltaExt.applyDelta(a, d);
        expect(out.state.setEquals(b)).toBe(true);
        expect(out.delta.equals(d)).toBe(true);
      }),
    );
  });
});

describe("HashMap.applyDelta / computeDelta", () => {
  test("applyDelta(empty, {Rem 1}) = (empty, {})", () => {
    const r = HashMapDeltaExt.applyDelta(
      HashMap.empty<number, number>(),
      HashMapDelta.ofArray([[1, ElementRemove]]),
    );
    expect(r.state.isEmpty).toBe(true);
    expect(r.delta.isEmpty).toBe(true);
  });

  test("applyDelta({1->1}, {Set 1->1}) = ({1->1}, {})", () => {
    const r = HashMapDeltaExt.applyDelta(
      HashMap.single(1, 1),
      HashMapDelta.ofArray([[1, ElementSet(1)]]),
    );
    expect(r.state.equals(HashMap.single(1, 1))).toBe(true);
    expect(r.delta.isEmpty).toBe(true);
  });

  test("computeDelta(A, A) is empty", () => {
    fc.assert(
      fc.property(arbIntMap, (l) => {
        const a = HashMap.ofArray<number, number>(l);
        const d = HashMapDeltaExt.computeDelta(a, a);
        expect(d.isEmpty).toBe(true);
      }),
    );
  });

  test("applyDelta(A, computeDelta(A, B)) = (B, computeDelta(A, B))", () => {
    fc.assert(
      fc.property(arbIntMap, arbIntMap, (l, r) => {
        const a = HashMap.ofArray<number, number>(l);
        const b = HashMap.ofArray<number, number>(r);
        const d = HashMapDeltaExt.computeDelta(a, b);
        const out = HashMapDeltaExt.applyDelta(a, d);
        expect(out.state.equals(b)).toBe(true);
        expect(out.delta.equals(d)).toBe(true);
      }),
    );
  });

  test("triangle: diff(A,B) ∘ diff(B,C) ∘ diff(C,A) applied to A returns A", () => {
    fc.assert(
      fc.property(arbIntMap, arbIntMap, arbIntMap, (l1, l2, l3) => {
        const a = HashMap.ofArray<number, number>(l1);
        const b = HashMap.ofArray<number, number>(l2);
        const c = HashMap.ofArray<number, number>(l3);
        const d12 = HashMapDeltaExt.computeDelta(a, b);
        const d23 = HashMapDeltaExt.computeDelta(b, c);
        const d31 = HashMapDeltaExt.computeDelta(c, a);
        const combined = d12.combine(d23).combine(d31);
        const out = HashMapDeltaExt.applyDelta(a, combined);
        expect(out.state.equals(a)).toBe(true);
      }),
    );
  });
});

// =============================================================================
// Full F# test ports — HashMap.fs
// =============================================================================

describe("[HashMap] ported", () => {
  // [HashMap] count
  test("count invariants", () => {
    fc.assert(
      fc.property(arbMap, fc.string(), (l, a) => {
        const lMap = new Map(Object.entries(l));
        if (lMap.has(a)) return; // F# precondition
        const map = HashMap.ofArray<string, number>([...lMap]);
        const mapWithA = map.add(a, 0);
        expect(HashMap.empty<string, number>().count).toBe(0);
        expect(mapWithA.count).toBe(map.count + 1);
        expect(mapWithA.remove(a).count).toBe(map.count);
        expect(map.count).toBe(Object.keys(l).length);
        expect(map.unionWith(map).count).toBe(map.count);
        expect(map.map((_k, v) => v).count).toBe(map.count);
        expect(map.filter(() => true).count).toBe(map.count);
        expect(map.filter(() => false).count).toBe(0);
        expect(map.choose((_k, v) => v).count).toBe(map.count);
        expect(map.choose(() => undefined).count).toBe(0);
        expect(mapWithA.alter(a, () => undefined).count).toBe(map.count);
        expect(mapWithA.alter(a, () => 5).count).toBe(mapWithA.count);
        expect(mapWithA.update(a, () => 5).count).toBe(mapWithA.count);
        expect(map.count).toBe(lMap.size);
      }),
    );
  });

  // [HashMap] tryFind
  test("tryFind invariants", () => {
    fc.assert(
      fc.property(arbMap, fc.string(), (l, a) => {
        const lMap = new Map(Object.entries(l));
        if (lMap.has(a)) return;
        const map = HashMap.ofArray<string, number>([...lMap]);
        const mapWithA = map.add(a, 0);
        expect(mapWithA.tryFind(a)).toBe(0);
        expect(map.tryFind(a)).toBeUndefined();
        expect(mapWithA.add(a, 7).tryFind(a)).toBe(7);
        expect(map.add(a, 7).tryFind(a)).toBe(7);
        expect(mapWithA.remove(a).tryFind(a)).toBeUndefined();
        expect(map.unionWith(mapWithA).tryFind(a)).toBe(0);
        expect(mapWithA.alter(a, () => 100).tryFind(a)).toBe(100);
        expect(mapWithA.alter(a, () => undefined).tryFind(a)).toBeUndefined();
        expect(mapWithA.update(a, () => 123).tryFind(a)).toBe(123);
        expect(map.update(a, () => 123).tryFind(a)).toBe(123);
        expect(mapWithA.choose((_k, v) => v).tryFind(a)).toBe(0);
        expect(mapWithA.choose(() => undefined).tryFind(a)).toBeUndefined();
        expect(mapWithA.choose(() => 7).tryFind(a)).toBe(7);
        expect(mapWithA.filter(() => true).tryFind(a)).toBe(0);
        expect(mapWithA.filter(() => false).tryFind(a)).toBeUndefined();
      }),
    );
  });

  // [HashMap] containsKey
  test("containsKey agrees with tryFind", () => {
    fc.assert(
      fc.property(arbMap, fc.string(), (l, a) => {
        const map = HashMap.ofArray<string, number>([...new Map(Object.entries(l))]);
        expect(map.containsKey(a)).toBe(map.tryFind(a) !== undefined);
      }),
    );
  });

  // [HashMap] find
  test("find returns the inserted value", () => {
    fc.assert(
      fc.property(arbMap, fc.string(), (l, a) => {
        const map = HashMap.ofArray<string, number>([
          ...new Map(Object.entries(l)),
        ]).add(a, 42);
        expect(map.get(a)).toBe(42);
      }),
    );
  });

  // [HashMap] ofList
  test("ofList round-trips Map.ofList", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer(), fc.integer()), { maxLength: 100 }),
        (entries) => {
          const sorted = sortByKey(HashMap.ofArray(entries).toList());
          const ref = sortByKey([...new Map(entries).entries()]);
          expect(sorted).toEqual(ref);
        },
      ),
    );
  });

  // [HashMap] map2/choose2
  test("map2 and choose2V agree with a Map oracle", () => {
    fc.assert(
      fc.property(arbMap, arbMap, (lm, rm) => {
        // PORT NOTE: Object.entries returns own enumerable keys, but
        // `ll[k]` for k=='valueOf'/'toString'/etc. would resolve through
        // Object.prototype. Convert to JS Maps for clean lookup.
        const lmMap = new Map(Object.entries(lm));
        const rmMap = new Map(Object.entries(rm));
        const l = HashMap.ofArray<string, number>([...lmMap]);
        const r = HashMap.ofArray<string, number>([...rmMap]);

        const map2Oracle = (
          f: (k: string, a: number | undefined, b: number | undefined) => number,
          ll: Map<string, number>,
          rr: Map<string, number>,
        ): Map<string, number> => {
          const out = new Map<string, number>();
          for (const k of new Set([...ll.keys(), ...rr.keys()])) {
            out.set(k, f(k, ll.get(k), rr.get(k)));
          }
          return out;
        };

        const choose2Oracle = (
          f: (k: string, a: number | undefined, b: number | undefined) => number | undefined,
          ll: Map<string, number>,
          rr: Map<string, number>,
        ): Map<string, number> => {
          const out = new Map<string, number>();
          for (const k of new Set([...ll.keys(), ...rr.keys()])) {
            const v = f(k, ll.get(k), rr.get(k));
            if (v !== undefined) out.set(k, v);
          }
          return out;
        };

        const add = (_k: string, a: number | undefined, b: number | undefined): number => {
          if (a !== undefined && b !== undefined) return a + b;
          if (a !== undefined) return a;
          if (b !== undefined) return b;
          throw new Error("Map invented a key");
        };
        const add2 = (
          _k: string,
          a: number | undefined,
          b: number | undefined,
        ): number | undefined => {
          if (a !== undefined && b !== undefined) return a > b ? b : undefined;
          if (a !== undefined) return a;
          if (b !== undefined) return b;
          throw new Error("Map invented a key");
        };

        const equal = (
          h: HashMap<string, number>,
          ref: Map<string, number>,
        ): void => {
          expect(sortByKey(h.toList())).toEqual(sortByKey([...ref]));
        };

        equal(l.map2(r, add), map2Oracle(add, lmMap, rmMap));
        equal(l.choose2V(r, (k, a, b) => add(k, a, b)), map2Oracle(add, lmMap, rmMap));
        equal(l.choose2V(r, add2), choose2Oracle(add2, lmMap, rmMap));
      }),
    );
  });

  // [HashMap] intersect
  test("intersect agrees with a Map oracle", () => {
    fc.assert(
      fc.property(arbMap, arbMap, (lm, rm) => {
        const lmMap = new Map(Object.entries(lm));
        const rmMap = new Map(Object.entries(rm));
        const l = HashMap.ofArray<string, number>([...lmMap]);
        const r = HashMap.ofArray<string, number>([...rmMap]);
        const oracle = new Map<string, [number, number]>();
        for (const [k, v] of lmMap) {
          const rv = rmMap.get(k);
          if (rv !== undefined) oracle.set(k, [v, rv]);
        }
        const result = sortByKey(l.intersect(r).toList());
        const ref = sortByKey([...oracle]);
        expect(result).toEqual(ref);
      }),
    );
  });

  // [HashMap] enumerator correct
  test("[HashMap] enumerator agrees with toList", () => {
    fc.assert(
      fc.property(arbMap, (m) => {
        const ref = new Map(Object.entries(m));
        const h = HashMap.ofArray<string, number>([...ref]);
        expect([...h]).toEqual(h.toList());
        expect(sortByKey([...h])).toEqual(sortByKey([...ref]));
      }),
    );
  });

  // [HashMap] choose
  test("choose agrees with a Map oracle", () => {
    fc.assert(
      fc.property(arbMap, (m) => {
        const ref = new Map(Object.entries(m));
        const h = HashMap.ofArray<string, number>([...ref]);
        const f = (_k: string, v: number) => (v % 2 === 0 ? v * 10 : undefined);
        const oracle = new Map<string, number>();
        for (const [k, v] of ref) {
          const r = f(k, v);
          if (r !== undefined) oracle.set(k, r);
        }
        const got = sortByKey(h.choose(f).toList());
        expect(got).toEqual(sortByKey([...oracle]));
      }),
    );
  });

  // [HashMap] equality (StupidHash variant)
  test("structural equality survives insertion-order permutation under colliding hashes", () => {
    fc.assert(
      fc.property(arbStupidHash, (h0) => {
        const h1 = new StupidHash(h0.value + 1);
        const h2 = new StupidHash(h0.value + 2);
        const h3 = new StupidHash(h0.value + 3);
        const empty = HashMap.empty<StupidHash, number>(stupidHashCmp);
        const a = empty.add(h0, 0).add(h1, 1).add(h2, 2).add(h3, 3);
        const b = empty.add(h1, 1).add(h2, 2).add(h3, 3).add(h0, 0);
        const c = empty.add(h2, 2).add(h3, 3).add(h0, 0).add(h1, 1);
        const d = empty.add(h3, 3).add(h0, 0).add(h1, 1).add(h2, 2);
        const e = HashMap.ofArray<StupidHash, number>(
          [[h1, 1], [h0, 0], [h3, 3], [h2, 2]],
          stupidHashCmp,
        );
        const x = d.add(h3, 4);
        const y = d.add(new StupidHash(h0.value + 4), 4);
        const z = d.remove(h3);

        expect(a.equals(a)).toBe(true);
        expect(a.equals(b)).toBe(true);
        expect(a.equals(c)).toBe(true);
        expect(a.equals(d)).toBe(true);
        expect(a.equals(e)).toBe(true);
        expect(b.equals(c)).toBe(true);
        expect(d.equals(c)).toBe(true);

        expect(a.getHash()).toBe(b.getHash());
        expect(b.getHash()).toBe(c.getHash());
        expect(c.getHash()).toBe(d.getHash());
        expect(d.getHash()).toBe(e.getHash());

        expect(a.equals(x)).toBe(false);
        expect(a.equals(y)).toBe(false);
        expect(x.equals(y)).toBe(false);
        expect(z.equals(a)).toBe(false);

        expect(a.count).toBe(4);
        expect(b.count).toBe(4);
        expect(c.count).toBe(4);
        expect(d.count).toBe(4);
        expect(x.count).toBe(4); // x replaces h3's value, doesn't add a new key
        expect(y.count).toBe(5);
      }),
    );
  });
});

// =============================================================================
// Full F# test ports — HashSet.fs (pure HashSet entries; CountingHashSet
// belongs to phase 4 / Traceable layer).
// =============================================================================

describe("[HashSet] ported", () => {
  // [HashSet] applyDelta drops useless removes
  test("applyDelta drops useless removes", () => {
    const empty = HashSet.empty<number>();
    {
      const r = HashSetDeltaExt.applyDelta(
        empty,
        HashSetDelta.ofArray([SetOperation.rem(1)]),
      );
      expect(r.state.setEquals(empty)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
    {
      const set = HashSet.ofArray([1]);
      const r = HashSetDeltaExt.applyDelta(set, HashSetDelta.empty());
      expect(r.state.setEquals(set)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
    {
      const set = HashSet.ofArray(Array.from({ length: 19 }, (_, i) => i + 2));
      const r = HashSetDeltaExt.applyDelta(
        set,
        HashSetDelta.ofArray([SetOperation.rem(1)]),
      );
      expect(r.state.setEquals(set)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
    {
      const set = HashSet.single(21);
      const ops = Array.from({ length: 20 }, (_, i) => SetOperation.rem(i + 1));
      const r = HashSetDeltaExt.applyDelta(set, HashSetDelta.ofArray(ops));
      expect(r.state.setEquals(set)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
    {
      const set = HashSet.ofArray(Array.from({ length: 20 }, (_, i) => i + 1));
      const ops = Array.from({ length: 20 }, (_, i) => SetOperation.rem(i + 21));
      const r = HashSetDeltaExt.applyDelta(set, HashSetDelta.ofArray(ops));
      expect(r.state.setEquals(set)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
  });

  // [HashSet] applyDelta drops useless adds
  test("applyDelta drops useless adds", () => {
    {
      const set = HashSet.single(1);
      const r = HashSetDeltaExt.applyDelta(
        set,
        HashSetDelta.ofArray([SetOperation.add(1)]),
      );
      expect(r.state.setEquals(set)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
    {
      const set = HashSet.ofArray(Array.from({ length: 20 }, (_, i) => i + 1));
      const r = HashSetDeltaExt.applyDelta(
        set,
        HashSetDelta.ofArray([SetOperation.add(1)]),
      );
      expect(r.state.setEquals(set)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
    {
      const set = HashSet.ofArray(Array.from({ length: 20 }, (_, i) => i + 1));
      const ops = Array.from({ length: 20 }, (_, i) => SetOperation.add(i + 1));
      const r = HashSetDeltaExt.applyDelta(set, HashSetDelta.ofArray(ops));
      expect(r.state.setEquals(set)).toBe(true);
      expect(r.delta.isEmpty).toBe(true);
    }
  });

  // [HashSet] applyDelta basic
  test("applyDelta basic", () => {
    {
      const delta = HashSetDelta.ofArray([SetOperation.add(20)]);
      const set = HashSet.ofArray(Array.from({ length: 19 }, (_, i) => i + 1));
      const r = HashSetDeltaExt.applyDelta(set, delta);
      expect(r.state.setEquals(HashSet.ofArray(Array.from({ length: 20 }, (_, i) => i + 1)))).toBe(true);
      expect(r.delta.equals(delta)).toBe(true);
    }
    {
      const delta = HashSetDelta.ofArray(
        Array.from({ length: 20 }, (_, i) => SetOperation.add(i + 1)),
      );
      const set = HashSet.ofArray([1]);
      const r = HashSetDeltaExt.applyDelta(set, delta);
      expect(
        r.state.setEquals(HashSet.ofArray(Array.from({ length: 20 }, (_, i) => i + 1))),
      ).toBe(true);
      const expected = HashSetDelta.ofArray(
        Array.from({ length: 19 }, (_, i) => SetOperation.add(i + 2)),
      );
      expect(r.delta.equals(expected)).toBe(true);
    }
  });

  // [HashSet] computeDelta/applyDelta full identities
  test("computeDelta / applyDelta identities", () => {
    fc.assert(
      fc.property(arbSet, arbSet, arbSet, (l1, l2, l3) => {
        const s1 = HashSet.ofArray(l1);
        const s2 = HashSet.ofArray(l2);
        const s3 = HashSet.ofArray(l3);
        const empty = HashSetDelta.empty<number>();
        expect(HashSetDeltaExt.computeDelta(s1, s1).isEmpty).toBe(true);
        expect(HashSetDeltaExt.computeDelta(s2, s2).isEmpty).toBe(true);

        const e1 = HashSetDeltaExt.applyDelta(s1, empty);
        expect(e1.state.setEquals(s1)).toBe(true);
        expect(e1.delta.isEmpty).toBe(true);

        const fw = HashSetDeltaExt.computeDelta(s1, s2);
        const r = HashSetDeltaExt.applyDelta(s1, fw);
        expect(r.state.setEquals(s2)).toBe(true);
        expect(r.delta.equals(fw)).toBe(true);

        const bw = HashSetDeltaExt.computeDelta(s2, s1);
        expect(bw.inverse.equals(fw)).toBe(true);
        expect(fw.combine(bw).isEmpty).toBe(true);

        const d12 = HashSetDeltaExt.computeDelta(s1, s2);
        const d23 = HashSetDeltaExt.computeDelta(s2, s3);
        const d31 = HashSetDeltaExt.computeDelta(s3, s1);
        expect(d12.combine(d23).combine(d31).isEmpty).toBe(true);
        expect(d12.combine(d23).equals(d31.inverse)).toBe(true);
      }),
    );
  });

  // [HashSet] count
  test("count invariants", () => {
    fc.assert(
      fc.property(arbSet, fc.integer(), (l, a) => {
        const set = HashSet.ofArray(Array.from(new Set(l)));
        if (set.contains(a)) return;
        const setWithA = set.add(a);
        expect(HashSet.empty<number>().count).toBe(0);
        expect(setWithA.count).toBe(set.count + 1);
        expect(setWithA.remove(a).count).toBe(set.count);
        expect(set.count).toBe(new Set(l).size);
        expect(set.unionWith(set).count).toBe(set.count);
        expect(set.unionWith(setWithA).count).toBe(setWithA.count);
        expect(setWithA.exceptWith(set).count).toBe(1);
        expect(setWithA.intersectWith(set).count).toBe(set.count);
        expect(set.map((x) => x).count).toBe(set.count);
        expect(set.filter(() => true).count).toBe(set.count);
        expect(set.filter(() => false).count).toBe(0);
        expect(set.choose((x) => x).count).toBe(set.count);
        expect(set.choose(() => undefined).count).toBe(0);
        expect(setWithA.choose(() => 1).count).toBe(1);
        expect(setWithA.alter(a, () => false).count).toBe(set.count);
        expect(setWithA.alter(a, () => true).count).toBe(setWithA.count);
      }),
    );
  });

  // [HashSet] contains
  test("contains invariants", () => {
    fc.assert(
      fc.property(arbSet, fc.integer(), (l, a) => {
        const set = HashSet.ofArray(Array.from(new Set(l)));
        if (set.contains(a)) return;
        const setWithA = set.add(a);
        expect(setWithA.contains(a)).toBe(true);
        expect(set.contains(a)).toBe(false);
        expect(setWithA.add(a).contains(a)).toBe(true);
        expect(set.add(a).contains(a)).toBe(true);
        expect(setWithA.remove(a).contains(a)).toBe(false);
        expect(set.unionWith(setWithA).contains(a)).toBe(true);
        expect(setWithA.exceptWith(set).contains(a)).toBe(true);
        expect(setWithA.intersectWith(set).contains(a)).toBe(false);
        expect(setWithA.alter(a, () => true).contains(a)).toBe(true);
        expect(setWithA.alter(a, () => false).contains(a)).toBe(false);
      }),
    );
  });

  // [HashSet] union/difference/intersect/xor algebraic identities
  test("union identities", () => {
    fc.assert(
      fc.property(arbSet, arbSet, (l, r) => {
        const a = HashSet.ofArray(l);
        const b = HashSet.ofArray(r);
        const empty = HashSet.empty<number>();
        const union = a.unionWith(b);
        const oracle = new Set([...l, ...r]);
        expect(union.count).toBe(oracle.size);
        expect(a.unionWith(a).setEquals(a)).toBe(true);
        expect(empty.unionWith(a).setEquals(a)).toBe(true);
        expect(a.unionWith(empty).setEquals(a)).toBe(true);
        expect(a.unionWith(b).setEquals(b.unionWith(a))).toBe(true);
      }),
    );
  });

  test("difference identities", () => {
    fc.assert(
      fc.property(arbSet, arbSet, (l, r) => {
        const a = HashSet.ofArray(l);
        const b = HashSet.ofArray(r);
        const empty = HashSet.empty<number>();
        const oracle = new Set([...l].filter((x) => !new Set(r).has(x)));
        expect(a.exceptWith(b).count).toBe(oracle.size);
        expect(a.exceptWith(a).setEquals(empty)).toBe(true);
        expect(empty.exceptWith(a).setEquals(empty)).toBe(true);
        expect(a.exceptWith(empty).setEquals(a)).toBe(true);
      }),
    );
  });

  test("intersect identities", () => {
    fc.assert(
      fc.property(arbSet, arbSet, (l, r) => {
        const a = HashSet.ofArray(l);
        const b = HashSet.ofArray(r);
        const empty = HashSet.empty<number>();
        const oracle = new Set([...l].filter((x) => new Set(r).has(x)));
        expect(a.intersectWith(b).count).toBe(oracle.size);
        expect(a.intersectWith(a).setEquals(a)).toBe(true);
        expect(empty.intersectWith(a).setEquals(empty)).toBe(true);
        expect(a.intersectWith(empty).setEquals(empty)).toBe(true);
      }),
    );
  });

  test("intersectionCount agrees with intersect.count", () => {
    fc.assert(
      fc.property(arbSet, arbSet, (l, r) => {
        const a = HashSet.ofArray(l);
        const b = HashSet.ofArray(r);
        const empty = HashSet.empty<number>();
        const inter = new Set([...l].filter((x) => new Set(r).has(x)));
        expect(a.intersectionCount(b)).toBe(inter.size);
        expect(a.intersectionCount(empty)).toBe(0);
        expect(empty.intersectionCount(b)).toBe(0);
        expect(b.intersectionCount(b)).toBe(new Set(r).size);
      }),
    );
  });

  test("xor identities", () => {
    fc.assert(
      fc.property(arbSet, arbSet, (l, r) => {
        const a = HashSet.ofArray(l);
        const b = HashSet.ofArray(r);
        const empty = HashSet.empty<number>();
        const ls = new Set(l);
        const rs = new Set(r);
        const oracle = new Set(
          [...l, ...r].filter(
            (x) => (ls.has(x) ? !rs.has(x) : rs.has(x)),
          ),
        );
        expect(a.symmetricExceptWith(b).count).toBe(oracle.size);
        expect(a.symmetricExceptWith(a).setEquals(empty)).toBe(true);
        expect(empty.symmetricExceptWith(a).setEquals(a)).toBe(true);
        expect(a.symmetricExceptWith(empty).setEquals(a)).toBe(true);
        expect(
          a
            .symmetricExceptWith(b)
            .setEquals(b.symmetricExceptWith(a)),
        ).toBe(true);
      }),
    );
  });

  // [HashSet] ofList
  test("ofList round-trips Set.ofList", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 100 }), (l) => {
        const got = [...HashSet.ofArray(l)].sort((x, y) => x - y);
        const ref = [...new Set(l)].sort((x, y) => x - y);
        expect(got).toEqual(ref);
      }),
    );
  });

  // [HashSet] enumerator correct
  test("enumerator agrees with toList", () => {
    fc.assert(
      fc.property(arbSet, (m) => {
        const h = HashSet.ofArray(m);
        expect([...h]).toEqual(h.toList());
        expect([...h].sort((a, b) => a - b)).toEqual(
          [...new Set(m)].sort((a, b) => a - b),
        );
      }),
    );
  });

  // [HashSet] map / choose / filter against Set oracle
  test("map / choose / filter agree with Set oracle", () => {
    fc.assert(
      fc.property(arbSet, (s) => {
        const set = new Set(s);
        const h = HashSet.ofArray(s);

        const f = (x: number) => x * 2 + 1;
        const refMap = [...new Set([...set].map(f))].sort((a, b) => a - b);
        expect([...h.map(f)].sort((a, b) => a - b)).toEqual(refMap);

        const choose = (x: number) => (x % 3 === 0 ? x : undefined);
        const refChoose = [
          ...new Set([...set].map(choose).filter((x): x is number => x !== undefined)),
        ].sort((a, b) => a - b);
        expect([...h.choose(choose)].sort((a, b) => a - b)).toEqual(refChoose);

        const pred = (x: number) => x % 2 === 0;
        const refFilter = [...set].filter(pred).sort((a, b) => a - b);
        expect([...h.filter(pred)].sort((a, b) => a - b)).toEqual(refFilter);
      }),
    );
  });

  // [HashSet] equality (StupidHash variant)
  test("structural equality survives insertion-order permutation under colliding hashes", () => {
    fc.assert(
      fc.property(arbStupidHash, (h0) => {
        const h1 = new StupidHash(h0.value + 1);
        const h2 = new StupidHash(h0.value + 2);
        const h3 = new StupidHash(h0.value + 3);
        const empty = HashSet.empty<StupidHash>(stupidHashCmp);
        const a = empty.add(h0).add(h1).add(h2).add(h3);
        const b = empty.add(h1).add(h2).add(h3).add(h0);
        const c = empty.add(h2).add(h3).add(h0).add(h1);
        const d = empty.add(h3).add(h0).add(h1).add(h2);
        const e = d.add(h3);
        const x = d.add(new StupidHash(h0.value + 4));

        expect(a.setEquals(a)).toBe(true);
        expect(a.setEquals(b)).toBe(true);
        expect(a.setEquals(c)).toBe(true);
        expect(a.setEquals(d)).toBe(true);
        expect(a.setEquals(e)).toBe(true);
        expect(b.setEquals(c)).toBe(true);

        expect(a.getHash()).toBe(b.getHash());
        expect(b.getHash()).toBe(c.getHash());
        expect(c.getHash()).toBe(d.getHash());
        expect(d.getHash()).toBe(e.getHash());

        expect(a.setEquals(x)).toBe(false);
        expect(a.count).toBe(4);
        expect(d.count).toBe(4);
        expect(e.count).toBe(4);
        expect(x.count).toBe(5);
      }),
    );
  });

  // [HashSet] applyDelta against a Set oracle
  test("applyDelta agrees with Set oracle for arbitrary delta", () => {
    fc.assert(
      fc.property(
        arbSet,
        fc.dictionary(
          fc.integer({ min: -50, max: 50 }).map((n) => String(n)),
          fc.integer({ min: -3, max: 3 }),
        ),
        (l, deltaDict) => {
          const delta: Record<string, number> = {};
          for (const [k, v] of Object.entries(deltaDict)) if (v !== 0) delta[k] = v;
          const m1 = new Set(l);
          const h1 = HashSet.ofArray(l);
          const md: Record<string, number> = {};
          let mState = new Set(m1);
          const me: Record<string, number> = {};
          for (const [kk, d] of Object.entries(delta)) {
            const k = Number(kk);
            if (mState.has(k)) {
              if (d < 0) {
                mState.delete(k);
                me[kk] = -1;
              }
            } else {
              if (d > 0) {
                mState.add(k);
                me[kk] = 1;
              }
            }
            md[kk] = d;
          }
          const hd = HashSetDelta.ofHashMap(
            HashMap.ofArray(
              Object.entries(md).map(([k, v]) => [Number(k), v] as [number, number]),
            ),
          );
          const r = HashSetDeltaExt.applyDelta(h1, hd);
          expect([...r.state].sort((a, b) => a - b)).toEqual(
            [...mState].sort((a, b) => a - b),
          );
          expect(
            sortByKey(r.delta.toMap().toList()),
          ).toEqual(
            sortByKey(
              Object.entries(me).map(([k, v]) => [Number(k), v] as [number, number]),
            ),
          );
        },
      ),
    );
  });
});
