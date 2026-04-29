// Verifies that ASet/AMap/AList `reduce` and `reduceBy` are
// genuinely incremental — not bulk recomputes on every change.
//
// Strategy: count how many times the reduction's `add`/`sub` / the
// `mapping` callback runs across a sequence of mutations, and assert
// the count matches "delta-only" semantics rather than "full state".

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AVal } from "../src/adaptiveValue/adaptiveValue.js";
import type { AdaptiveReduction } from "../src/adaptiveValue/adaptiveReduction.js";
import { HashSet } from "../src/datastructures/hashCollections.js";
import { cset } from "../src/adaptiveHashSet/changeableHashSet.js";
import { cmap } from "../src/adaptiveHashMap/changeableHashMap.js";
import { clist } from "../src/adaptiveIndexList/changeableIndexList.js";
import { ASet } from "../src/adaptiveHashSet/adaptiveHashSet.js";
import { AMap } from "../src/adaptiveHashMap/adaptiveHashMap.js";
import { AList } from "../src/adaptiveIndexList/adaptiveIndexList.js";

interface Counts {
  adds: number;
  subs: number;
}

function countingSum(c: Counts): AdaptiveReduction<number, number, number> {
  return {
    seed: 0,
    add: (s, v) => {
      c.adds += 1;
      return s + v;
    },
    sub: (s, v) => {
      c.subs += 1;
      return s - v;
    },
    view: (s) => s,
  };
}

describe("ReduceValue is incremental", () => {
  test("ASet.reduce: delta-bounded add/sub on small mutations", () => {
    const c: Counts = { adds: 0, subs: 0 };
    const s = cset<number>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const r = ASet.reduce(countingSum(c), s);

    // Initial pull: bulk path expected since state.count <= ops.count.
    expect(AVal.force(r)).toBe(55);
    const initialAdds = c.adds;
    expect(initialAdds).toBe(10);
    expect(c.subs).toBe(0);

    // Single add: should be incremental — exactly one extra `add`.
    transact(() => s.add(11));
    expect(AVal.force(r)).toBe(66);
    expect(c.adds).toBe(initialAdds + 1);
    expect(c.subs).toBe(0);

    // Single remove: should be exactly one extra `sub`.
    transact(() => s.remove(1));
    expect(AVal.force(r)).toBe(65);
    expect(c.adds).toBe(initialAdds + 1);
    expect(c.subs).toBe(1);

    // Two-op transaction: 1 add + 1 sub.
    transact(() => {
      s.add(100);
      s.remove(2);
    });
    expect(AVal.force(r)).toBe(65 + 100 - 2);
    expect(c.adds).toBe(initialAdds + 2);
    expect(c.subs).toBe(2);
  });

  test("AMap.reduce: delta-bounded add/sub on small mutations", () => {
    const c: Counts = { adds: 0, subs: 0 };
    const m = cmap<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
      ["f", 6],
    ]);
    const r = AMap.reduce(countingSum(c), m);

    expect(AVal.force(r)).toBe(21);
    const initialAdds = c.adds;
    expect(initialAdds).toBe(6);
    expect(c.subs).toBe(0);

    transact(() => m.add("g", 7));
    expect(AVal.force(r)).toBe(28);
    expect(c.adds).toBe(initialAdds + 1);
    expect(c.subs).toBe(0);

    transact(() => m.set("a", 10)); // a: 1 → 10
    expect(AVal.force(r)).toBe(28 - 1 + 10);
    expect(c.adds).toBe(initialAdds + 2);
    expect(c.subs).toBe(1);

    transact(() => m.remove("g"));
    expect(AVal.force(r)).toBe(30);
    expect(c.adds).toBe(initialAdds + 2);
    expect(c.subs).toBe(2);
  });

  test("AList.reduce: delta-bounded add/sub on small mutations", () => {
    const c: Counts = { adds: 0, subs: 0 };
    const l = clist<number>([1, 2, 3, 4, 5, 6]);
    const r = AList.reduce(countingSum(c), l);

    expect(AVal.force(r)).toBe(21);
    const initialAdds = c.adds;
    expect(initialAdds).toBe(6);
    expect(c.subs).toBe(0);

    transact(() => l.add(7));
    expect(AVal.force(r)).toBe(28);
    expect(c.adds).toBe(initialAdds + 1);
    expect(c.subs).toBe(0);

    transact(() => l.removeAt(0));
    expect(AVal.force(r)).toBe(27);
    expect(c.adds).toBe(initialAdds + 1);
    expect(c.subs).toBe(1);
  });

  test("bulk-recompute kicks in when ops.count >= state.count", () => {
    const c: Counts = { adds: 0, subs: 0 };
    const s = cset<number>([1, 2, 3]);
    const r = ASet.reduce(countingSum(c), s);

    // Initial: 3 adds (bulk path because state.count <= 2 fails but
    // state.count <= ops.count holds).
    expect(AVal.force(r)).toBe(6);
    expect(c.adds).toBe(3);
    expect(c.subs).toBe(0);

    // Replace entire content (3 removes + 4 adds = 7 ops vs
    // state.count=3 → bulk-recompute branch).
    transact(() => {
      s.value = HashSet.ofArray([10, 20, 30, 40]);
    });
    expect(AVal.force(r)).toBe(100);
    // Bulk path: 4 fresh `add` calls; no `sub`.
    expect(c.subs).toBe(0);
  });
});

describe("ReduceByValue is incremental + caches mapping", () => {
  test("AMap.reduceBy: mapping called only for new/changed entries", () => {
    const calls: number[] = [];
    const m = cmap<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
    ]);
    const r = AMap.reduceBy(
      (() => {
        const c: Counts = { adds: 0, subs: 0 };
        return countingSum(c);
      })(),
      (_k, v: number) => {
        calls.push(v);
        return v * 10;
      },
      m,
    );

    AVal.force(r);
    expect(calls.length).toBe(5);

    transact(() => m.add("f", 6));
    AVal.force(r);
    expect(calls.length).toBe(6); // only "f" mapped
    expect(calls[5]).toBe(6);

    transact(() => m.set("a", 1)); // same value → mapping NOT re-run
    AVal.force(r);
    expect(calls.length).toBe(6);

    transact(() => m.set("a", 100)); // changed value → mapping runs once
    AVal.force(r);
    expect(calls.length).toBe(7);
    expect(calls[6]).toBe(100);
  });
});
