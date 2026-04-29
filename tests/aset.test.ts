// Port of FSharp.Data.Adaptive.Tests/ASet.fs
//
// PORT NOTE: skipped tests rely on parts of the F# library not yet
// ported here:
//   * `[ASet] reference impl` — uses Generators + the Reference impl namespace.
//   * `[ASet] mapUse` — `ASet.mapUse` not ported (no IDisposable in TS).
//   * `[ASet] reduceByA group/half group/fold` — `ASet.reduceByA` not ported.
//   * `[ASet] range smoke` / `range systematic *` — `ASet.range` not ported.
//   * `[ASet] mapA/flattenA/chooseA async` — F# multi-thread stress test.
//   * `[ASet] ofSetTree` — `ASet.ofSetTree` / SetTree not ported.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { HashSet } from "../src/datastructures/hashCollections.js";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";
import * as Reductions from "../src/adaptiveValue/adaptiveReduction.js";
import { ASet, force as asetForce } from "../src/adaptiveHashSet/adaptiveHashSet.js";
import { cset } from "../src/adaptiveHashSet/changeableHashSet.js";

function setEqualNum(actual: Iterable<number>, expected: number[]): void {
  expect([...actual].sort((a, b) => a - b)).toEqual(
    expected.slice().sort((a, b) => a - b),
  );
}

describe("[CSet] contains/isEmpty/count", () => {
  test("basic mutation flips state", () => {
    const set = cset(HashSet.ofList([1, 2]));

    expect(set.isEmpty).toBe(false);
    expect(set.count).toBe(2);
    expect(set.contains(1)).toBe(true);
    expect(set.contains(2)).toBe(true);

    transact(() => {
      expect(set.remove(2)).toBe(true);
    });

    expect(set.isEmpty).toBe(false);
    expect(set.count).toBe(1);
    expect(set.contains(1)).toBe(true);
    expect(set.contains(2)).toBe(false);

    transact(() => {
      expect(set.remove(1)).toBe(true);
    });

    expect(set.isEmpty).toBe(true);
    expect(set.count).toBe(0);
    expect(set.contains(1)).toBe(false);
    expect(set.contains(2)).toBe(false);
  });
});

describe("[CSet] intersectWith", () => {
  test("retains only common elements", () => {
    const s = cset([1, 2, 3, 4]);
    transact(() => s.intersectWith([2, 3, 5]));
    setEqualNum(s.value, [2, 3]);
  });
});

describe("[ASet] reduce group", () => {
  test("sum reacts to add/remove/clear", () => {
    const set = cset([1, 2, 3]);
    const res = ASet.reduce(Reductions.sum, set);

    expect(AVal.force(res)).toBe(6);
    transact(() => set.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => set.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => set.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[ASet] reduce half group", () => {
  test("product handles zero element", () => {
    const list = cset([1, 2, 3]);
    const res = ASet.reduce(Reductions.product, list);

    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(24);
    transact(() => list.remove(1));
    expect(AVal.force(res)).toBe(24);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(1);

    transact(() => list.add(0));
    expect(AVal.force(res)).toBe(0);
    transact(() => list.add(10));
    expect(AVal.force(res)).toBe(0);
    transact(() => list.add(2));
    expect(AVal.force(res)).toBe(0);

    transact(() => list.remove(0));
    expect(AVal.force(res)).toBe(20);
  });
});

describe("[ASet] reduce empty after lots of operations", () => {
  test("clear settles to zero, large content recomputes", () => {
    const s = cset<number>();
    const r = ASet.sum(s);
    transact(() => {
      for (let i = 1; i <= 10000; i++) s.add(Math.random());
    });
    AVal.force(r);

    transact(() => s.clear());
    expect(AVal.force(r)).toBe(0);

    transact(() => {
      for (let i = 1; i <= 10000; i++) s.add(Math.random());
    });

    const arr = [...s.value];
    const element = arr[Math.floor(Math.random() * arr.length)]!;
    transact(() => {
      s.value = HashSet.single(element);
    });
    expect(AVal.force(r)).toBe(element);
  });
});

describe("[ASet] reduce fold", () => {
  test("fold reduction reacts as a sum", () => {
    const list = cset([1, 2, 3]);
    const reduction = Reductions.fold(0, (a: number, b: number) => a + b);
    const res = ASet.reduce(reduction, list);

    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => list.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[ASet] reduceBy group", () => {
  test("sum after mapping", () => {
    const list = cset([1, 2, 3]);
    const res = ASet.reduceBy(Reductions.sum, (x: number) => x, list);

    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => list.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[ASet] reduceBy fold", () => {
  test("fold reduction after mapping", () => {
    const list = cset([1, 2, 3]);
    const reduction = Reductions.fold(0, (a: number, b: number) => a + b);
    const res = ASet.reduceBy(reduction, (x: number) => x, list);

    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => list.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[ASet] union constant", () => {
  test("union with constant reacts to mutations", () => {
    const constSet = ASet.ofList([1, 2, 3]);
    const changeSet = cset([4, 5, 6]);

    const union1 = ASet.union(constSet, changeSet);
    const union2 = ASet.union(changeSet, constSet);

    setEqualNum(asetForce(union1), [1, 2, 3, 4, 5, 6]);
    setEqualNum(asetForce(union2), [1, 2, 3, 4, 5, 6]);

    transact(() => changeSet.add(1));
    setEqualNum(asetForce(union1), [1, 2, 3, 4, 5, 6]);
    setEqualNum(asetForce(union2), [1, 2, 3, 4, 5, 6]);

    transact(() => changeSet.remove(1));
    setEqualNum(asetForce(union1), [1, 2, 3, 4, 5, 6]);
    setEqualNum(asetForce(union2), [1, 2, 3, 4, 5, 6]);

    transact(() => changeSet.remove(5));
    setEqualNum(asetForce(union1), [1, 2, 3, 4, 6]);
    setEqualNum(asetForce(union2), [1, 2, 3, 4, 6]);

    const constSet2 = ASet.ofList([1, 2, 3]);
    const changeSet2 = cset([3, 4, 5]);
    const u1 = ASet.union(constSet2, changeSet2);
    const u2 = ASet.union(changeSet2, constSet2);

    setEqualNum(asetForce(u1), [1, 2, 3, 4, 5]);
    setEqualNum(asetForce(u2), [1, 2, 3, 4, 5]);

    transact(() => changeSet2.remove(5));
    setEqualNum(asetForce(u1), [1, 2, 3, 4]);
    setEqualNum(asetForce(u2), [1, 2, 3, 4]);
  });
});

describe("[ASet] filterA", () => {
  test("dynamic predicate toggles inclusion", () => {
    const takeEven = cval(true);
    const takeOdd = cval(true);
    const set = ASet.ofArray([0, 1, 2, 3, 4]);

    const filtered = ASet.filterA(
      (i: number) => (i % 2 === 0 ? takeEven : takeOdd),
      set,
    );

    setEqualNum(asetForce(filtered), [0, 1, 2, 3, 4]);

    transact(() => {
      takeEven.value = false;
    });
    setEqualNum(asetForce(filtered), [1, 3]);

    transact(() => {
      takeOdd.value = false;
    });
    expect(asetForce(filtered).count).toBe(0);

    transact(() => {
      takeOdd.value = true;
      takeEven.value = true;
    });
    setEqualNum(asetForce(filtered), [0, 1, 2, 3, 4]);
  });
});

describe("[ASet] content bind", () => {
  test("bind on .content tracks underlying set growth", () => {
    const set = cset<number>();
    const res = ASet.bind(
      (s: HashSet<number>) => ASet.ofHashSet(s.map((v) => v * 2)),
      set.content,
    );

    for (let i = 1; i <= 50; i++) {
      transact(() => set.add(i));
      const cnt = asetForce(res).count;
      expect(cnt).toBe(set.count);
    }
  });
});
