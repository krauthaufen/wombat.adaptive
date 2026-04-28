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

const arbMap = fc.dictionary(fc.string(), fc.integer());
const arbSet = fc.array(fc.integer(), { maxLength: 200 });
const arbIntMap = fc.array(
  fc.tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer()),
  { maxLength: 100 },
);

const sortByKey = <K, V>(arr: Array<[K, V]>): Array<[K, V]> =>
  [...arr].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));

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
