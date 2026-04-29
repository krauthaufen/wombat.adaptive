// Port of FSharp.Data.Adaptive.Tests/AMap.fs
//
// PORT NOTE: skipped F# tests not portable yet —
//   * `[AMap] reference impl` — covered by `amapReference.test.ts`.
//   * `[AMap] mapUse` — `AMap.mapUse` not ported (no IDisposable).
//   * `[AMap] toASet` ordering test — relies on `ASet.sortBy` (not ported).
// Other reduce/reduceBy/reduceByA variants are present here at
// reduced numeric domains.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { HashMap } from "../src/datastructures/hashCollections.js";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";
import * as Reductions from "../src/adaptiveValue/adaptiveReduction.js";
import { AMap } from "../src/adaptiveHashMap/adaptiveHashMap.js";
import { cmap } from "../src/adaptiveHashMap/changeableHashMap.js";

describe("[AMap] reduce group", () => {
  test("sum reacts to add/remove/replace/clear", () => {
    const m = cmap<number, number>([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    const res = AMap.reduce(Reductions.sum, m);

    expect(AVal.force(res)).toBe(6);
    transact(() => m.add(4, 4));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => m.set(2, 3));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AMap] reduce half group", () => {
  test("product handles zero", () => {
    const m = cmap<number, number>([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    const res = AMap.reduce(Reductions.product, m);

    expect(AVal.force(res)).toBe(6);
    transact(() => m.add(4, 4));
    expect(AVal.force(res)).toBe(24);
    transact(() => m.remove(1));
    expect(AVal.force(res)).toBe(24);
    transact(() => m.clear());
    expect(AVal.force(res)).toBe(1);

    transact(() => m.add(0, 0));
    expect(AVal.force(res)).toBe(0);
    transact(() => m.add(10, 10));
    expect(AVal.force(res)).toBe(0);
    transact(() => m.add(2, 2));
    expect(AVal.force(res)).toBe(0);
    transact(() => m.remove(0));
    expect(AVal.force(res)).toBe(20);
    transact(() => m.set(10, 20));
    expect(AVal.force(res)).toBe(40);
  });
});

describe("[AMap] reduce empty after lots of operations", () => {
  test("clear settles to zero, large content recomputes", () => {
    const m = cmap<number, number>();
    const r = AMap.reduce(Reductions.sum, m);
    transact(() => {
      for (let i = 1; i <= 5000; i++) m.add(i, Math.random());
    });
    AVal.force(r);

    transact(() => m.clear());
    expect(AVal.force(r)).toBe(0);

    transact(() => {
      for (let i = 1; i <= 5000; i++) m.add(i, Math.random());
    });

    const arr = [...m.value];
    const [k, v] = arr[Math.floor(Math.random() * arr.length)]!;
    transact(() => {
      m.value = HashMap.single(k, v);
    });
    expect(AVal.force(r)).toBe(v);
  });
});

describe("[AMap] reduce fold", () => {
  test("fold reduction reacts as a sum", () => {
    const m = cmap<number, number>([[1, 1], [2, 2], [3, 3]]);
    const res = AMap.reduce(
      Reductions.fold(0, (a: number, b: number) => a + b),
      m,
    );

    expect(AVal.force(res)).toBe(6);
    transact(() => m.add(4, 4));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => m.set(4, 5));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AMap] reduceBy group", () => {
  test("sum after mapping", () => {
    const m = cmap<number, number>([[1, 1], [2, 2], [3, 3]]);
    const res = AMap.reduceBy(
      Reductions.sum,
      (_k: number, v: number) => v,
      m,
    );

    expect(AVal.force(res)).toBe(6);
    transact(() => m.add(4, 4));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => m.set(2, 3));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AMap] reduceBy fold", () => {
  test("fold reduction after mapping", () => {
    const m = cmap<number, number>([[1, 1], [2, 2], [3, 3]]);
    const res = AMap.reduceBy(
      Reductions.fold(0, (a: number, b: number) => a + b),
      (_k: number, v: number) => v,
      m,
    );
    expect(AVal.force(res)).toBe(6);
    transact(() => m.add(4, 4));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.remove(1));
    expect(AVal.force(res)).toBe(9);
    transact(() => m.set(4, 5));
    expect(AVal.force(res)).toBe(10);
    transact(() => m.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AMap] reduceByA group", () => {
  test("dynamic mapping with cval inputs", () => {
    const m = cmap<number, number>([[1, 1], [2, 2], [3, 3]]);
    const even = cval(1);
    const odd = cval(0);
    const mapping = (_k: number, v: number) => (v % 2 === 0 ? even : odd);

    const res = AMap.reduceByA(Reductions.sum, mapping, m);

    expect(AVal.force(res)).toBe(1); // (0)+(1)+(0)
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
    transact(() => m.add(4, 4));
    expect(AVal.force(res)).toBe(2);
    transact(() => {
      odd.value = 0;
      even.value = 1;
    });
    expect(AVal.force(res)).toBe(2);
    transact(() => m.add(5, 5));
    expect(AVal.force(res)).toBe(2);
    transact(() => m.add(6, 6));
    expect(AVal.force(res)).toBe(3);
    transact(() => {
      m.remove(5);
      m.remove(3);
      m.remove(1);
      odd.value = 1;
    });
    expect(AVal.force(res)).toBe(3);
    transact(() => {
      m.value = HashMap.ofArray<number, number>([
        [1, 1],
        [3, 3],
        [5, 5],
      ]);
    });
    expect(AVal.force(res)).toBe(3);
    transact(() => {
      even.value = 0;
      m.set(1, 2);
    });
    expect(AVal.force(res)).toBe(2);
  });
});
