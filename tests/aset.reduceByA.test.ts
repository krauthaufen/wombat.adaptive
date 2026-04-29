// Tests for ASet.reduceByA / existsA / forallA — port of the F# tests
// `[ASet] reduceByA group` / `half group` / `fold` (subset focused on
// the incremental machinery rather than custom half-group failures,
// which test internal recompute paths).

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { HashSet } from "../src/datastructures/hashCollections.js";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";
import * as Reductions from "../src/adaptiveValue/adaptiveReduction.js";
import { ASet } from "../src/adaptiveHashSet/adaptiveHashSet.js";
import { cset } from "../src/adaptiveHashSet/changeableHashSet.js";

describe("[ASet] reduceByA group", () => {
  test("dynamic mapping with cval inputs (sum)", () => {
    const list = cset<number>([1, 2, 3]);
    const even = cval(1);
    const odd = cval(0);
    const mapping = (v: number) => (v % 2 === 0 ? even : odd);
    const res = ASet.reduceByA(Reductions.sum, mapping, list);

    expect(AVal.force(res)).toBe(1);
    transact(() => {
      even.value = 2;
    });
    expect(AVal.force(res)).toBe(2);
    transact(() => {
      even.value = 1;
    });
    expect(AVal.force(res)).toBe(1);
    transact(() => {
      odd.value = 3;
    });
    expect(AVal.force(res)).toBe(7);
    transact(() => {
      odd.value = 1;
      even.value = 0;
    });
    expect(AVal.force(res)).toBe(2);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(2);
    transact(() => {
      odd.value = 0;
      even.value = 1;
    });
    expect(AVal.force(res)).toBe(2);
    transact(() => list.add(5));
    expect(AVal.force(res)).toBe(2);
    transact(() => list.add(6));
    expect(AVal.force(res)).toBe(3);
    transact(() => {
      list.remove(5);
      list.remove(3);
      list.remove(1);
      odd.value = 1;
    });
    expect(AVal.force(res)).toBe(3);
    transact(() => {
      list.value = HashSet.ofArray([1, 3, 5]);
    });
    expect(AVal.force(res)).toBe(3);
  });
});

describe("[ASet] forallA / existsA", () => {
  test("forallA reacts to inner aval flips", () => {
    const a = cval(true);
    const b = cval(true);
    const set = cset<number>([1, 2]);
    const r = ASet.forallA((v: number) => (v === 1 ? a : b), set);

    expect(AVal.force(r)).toBe(true);
    transact(() => {
      a.value = false;
    });
    expect(AVal.force(r)).toBe(false);
    transact(() => {
      a.value = true;
      b.value = false;
    });
    expect(AVal.force(r)).toBe(false);
    transact(() => {
      b.value = true;
    });
    expect(AVal.force(r)).toBe(true);
    transact(() => {
      set.add(3);
      b.value = false;
    });
    expect(AVal.force(r)).toBe(false);
  });

  test("existsA reacts to add/remove", () => {
    const set = cset<number>();
    const seen = cval(false);
    const r = ASet.existsA(() => seen, set);

    expect(AVal.force(r)).toBe(false);
    transact(() => set.add(1));
    expect(AVal.force(r)).toBe(false); // seen=false
    transact(() => {
      seen.value = true;
    });
    expect(AVal.force(r)).toBe(true);
    transact(() => set.clear());
    expect(AVal.force(r)).toBe(false);
  });
});
