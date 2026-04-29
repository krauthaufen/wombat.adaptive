// Tests for AList.range / AList.init / AList.sub*/take*/skip* and ASet.range.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";
import { AList } from "../src/adaptiveIndexList/adaptiveIndexList.js";
import { ASet } from "../src/adaptiveHashSet/adaptiveHashSet.js";

describe("AList.init", () => {
  test("constant length", () => {
    const l = AList.init(AVal.constant(5), (i) => i * 10);
    expect([...AVal.force(l.content)]).toEqual([0, 10, 20, 30, 40]);
  });

  test("dynamic length grows + shrinks", () => {
    const len = cval(3);
    const l = AList.init(len, (i) => i + 1);
    expect([...AVal.force(l.content)]).toEqual([1, 2, 3]);
    transact(() => {
      len.value = 5;
    });
    expect([...AVal.force(l.content)]).toEqual([1, 2, 3, 4, 5]);
    transact(() => {
      len.value = 2;
    });
    expect([...AVal.force(l.content)]).toEqual([1, 2]);
    transact(() => {
      len.value = 0;
    });
    expect([...AVal.force(l.content)]).toEqual([]);
  });
});

describe("AList.range", () => {
  test("constant range", () => {
    const r = AList.range(AVal.constant(2), AVal.constant(6));
    expect([...AVal.force(r.content)]).toEqual([2, 3, 4, 5, 6]);
  });

  test("empty range", () => {
    const r = AList.range(AVal.constant(5), AVal.constant(2));
    expect([...AVal.force(r.content)]).toEqual([]);
  });

  test("shifting bounds", () => {
    const lo = cval(1);
    const hi = cval(3);
    const r = AList.range(lo, hi);
    expect([...AVal.force(r.content)]).toEqual([1, 2, 3]);
    transact(() => {
      hi.value = 5;
    });
    expect([...AVal.force(r.content)]).toEqual([1, 2, 3, 4, 5]);
    transact(() => {
      lo.value = 0;
    });
    expect([...AVal.force(r.content)]).toEqual([0, 1, 2, 3, 4, 5]);
    transact(() => {
      lo.value = 3;
      hi.value = 4;
    });
    expect([...AVal.force(r.content)]).toEqual([3, 4]);
  });
});

describe("ASet.range", () => {
  test("static range", () => {
    const r = ASet.range(AVal.constant(0), AVal.constant(4));
    expect([...AVal.force(r.content)].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  test("dynamic range", () => {
    const lo = cval(1);
    const hi = cval(3);
    const r = ASet.range(lo, hi);
    expect([...AVal.force(r.content)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    transact(() => {
      hi.value = 5;
    });
    expect([...AVal.force(r.content)].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    transact(() => {
      lo.value = 4;
    });
    expect([...AVal.force(r.content)].sort((a, b) => a - b)).toEqual([4, 5]);
  });

  test("empty range removes everything", () => {
    const lo = cval(1);
    const hi = cval(3);
    const r = ASet.range(lo, hi);
    expect(AVal.force(r.content).count).toBe(3);
    transact(() => {
      hi.value = 0; // empty
    });
    expect(AVal.force(r.content).count).toBe(0);
  });
});

describe("AList.sub / take / skip", () => {
  test("sub static", () => {
    const l = AList.ofArray([10, 20, 30, 40, 50]);
    const s = AList.sub(1, 3, l);
    expect([...AVal.force(s.content)]).toEqual([20, 30, 40]);
  });

  test("subA dynamic offset/count", () => {
    const offset = cval(0);
    const count = cval(2);
    const l = AList.ofArray([1, 2, 3, 4, 5]);
    const s = AList.subA(offset, count, l);
    expect([...AVal.force(s.content)]).toEqual([1, 2]);
    transact(() => {
      offset.value = 2;
    });
    expect([...AVal.force(s.content)]).toEqual([3, 4]);
    transact(() => {
      count.value = 5;
    });
    expect([...AVal.force(s.content)]).toEqual([3, 4, 5]); // clamped to length
    transact(() => {
      offset.value = 99;
    });
    expect([...AVal.force(s.content)]).toEqual([]);
  });

  test("take and skip", () => {
    const l = AList.ofArray([1, 2, 3, 4, 5]);
    expect([...AVal.force(AList.take(3, l).content)]).toEqual([1, 2, 3]);
    expect([...AVal.force(AList.skip(2, l).content)]).toEqual([3, 4, 5]);
  });

  test("takeA and skipA", () => {
    const n = cval(2);
    const l = AList.ofArray([1, 2, 3, 4, 5]);
    const t = AList.takeA(n, l);
    const s = AList.skipA(n, l);
    expect([...AVal.force(t.content)]).toEqual([1, 2]);
    expect([...AVal.force(s.content)]).toEqual([3, 4, 5]);
    transact(() => {
      n.value = 4;
    });
    expect([...AVal.force(t.content)]).toEqual([1, 2, 3, 4]);
    expect([...AVal.force(s.content)]).toEqual([5]);
  });
});
