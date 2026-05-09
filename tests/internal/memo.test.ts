// Smoke tests for the per-combinator memoizers in `src/internal/memo.ts`.
// One representative test per (type, family). Focus areas:
//  - hit  : same source(s) + same fn -> referentially equal result
//  - miss : different source or different fn -> distinct result
//  - behaviour : memoized result behaves identically to non-memoized
//  - reactivity : updates propagate through the memoized derivation

import { describe, expect, test } from "vitest";

import { AVal, cval } from "../../src/adaptiveValue/adaptiveValue.js";
import {
  ASet,
  type aset,
} from "../../src/adaptiveHashSet/adaptiveHashSet.js";
import { cset } from "../../src/adaptiveHashSet/changeableHashSet.js";
import {
  AList,
  type alist,
} from "../../src/adaptiveIndexList/adaptiveIndexList.js";
import { clist } from "../../src/adaptiveIndexList/changeableIndexList.js";
import {
  AMap,
  type amap,
} from "../../src/adaptiveHashMap/adaptiveHashMap.js";
import { cmap } from "../../src/adaptiveHashMap/changeableHashMap.js";
import { transact } from "../../src/core/transaction.js";

import {
  __memo,
  memoAvalMap,
  memoAvalBind,
  memoAvalZipN,
  memoAsetMap,
  memoAsetFilter,
  memoAsetChoose,
  memoAsetCollect,
  memoAsetBind,
  memoAlistMap,
  memoAlistFilter,
  memoAlistChoose,
  memoAlistCollect,
  memoAlistBind,
  memoAmapMap,
  memoAmapFilter,
  memoAmapChoose,
  memoAmapBind,
} from "../../src/internal/memo.js";

const setSnap = <T>(s: aset<T>): T[] => ASet.force(s).toArray().sort() as T[];
const listSnap = <T>(l: alist<T>): T[] => AList.force(l).toArray() as T[];
const mapSnap = <K, V>(m: amap<K, V>): Array<[K, V]> => {
  const arr: Array<[K, V]> = [];
  for (const kv of AMap.force(m)) arr.push([kv[0], kv[1]]);
  return arr.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
};

describe("[internal] __memo", () => {
  test("hit + miss + compute-once", () => {
    const k1 = { tag: "k1" };
    const k2 = { tag: "k2" };
    let calls = 0;
    const compute = () => {
      calls++;
      return { id: calls };
    };
    const v1 = __memo([k1], compute);
    const v2 = __memo([k1], compute);
    const v3 = __memo([k2], compute);
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
    expect(calls).toBe(2);
  });
});

describe("[internal] memoAval*", () => {
  test("memoAvalMap: hit + miss + behaviour + reactivity", () => {
    const av = cval(2);
    const f = (x: number) => x * 10;
    const g = (x: number) => x * 10;
    const m = memoAvalMap(av, f);
    expect(memoAvalMap(av, f)).toBe(m);
    expect(memoAvalMap(av, g)).not.toBe(m);
    expect(AVal.force(m)).toBe(20);
    transact(() => {
      av.value = 7;
    });
    expect(AVal.force(m)).toBe(70);
  });

  test("memoAvalBind: hit + miss + behaviour", () => {
    const av = cval(3);
    const inner = cval(100);
    const f = (_x: number) => inner;
    const g = (_x: number) => inner;
    const m = memoAvalBind(av, f);
    expect(memoAvalBind(av, f)).toBe(m);
    expect(memoAvalBind(av, g)).not.toBe(m);
    expect(AVal.force(m)).toBe(100);
    transact(() => {
      inner.value = 200;
    });
    expect(AVal.force(m)).toBe(200);
  });

  test("memoAvalZipN: hit on same sources + fn", () => {
    const a = cval(1);
    const b = cval(2);
    const c = cval(3);
    const fn = (vs: ReadonlyArray<unknown>) =>
      (vs as number[]).reduce((s, x) => s + x, 0);
    const fn2 = (vs: ReadonlyArray<unknown>) =>
      (vs as number[]).reduce((s, x) => s + x, 0);
    const m = memoAvalZipN([a, b, c], fn);
    expect(memoAvalZipN([a, b, c], fn)).toBe(m);
    expect(memoAvalZipN([a, b, c], fn2)).not.toBe(m);
    expect(memoAvalZipN([a, b], fn)).not.toBe(m);
    expect(AVal.force(m)).toBe(6);
    transact(() => {
      b.value = 20;
    });
    expect(AVal.force(m)).toBe(24);
  });
});

describe("[internal] memoAset*", () => {
  test("memoAsetMap: hit + miss + behaviour + reactivity", () => {
    const s = cset<number>([1, 2, 3]);
    const f = (x: number) => x * 2;
    const g = (x: number) => x * 2;
    const m = memoAsetMap(s, f);
    expect(memoAsetMap(s, f)).toBe(m);
    expect(memoAsetMap(s, g)).not.toBe(m);
    expect(setSnap(m)).toEqual([2, 4, 6]);
    transact(() => {
      s.add(4);
    });
    expect(setSnap(m)).toEqual([2, 4, 6, 8]);
  });

  test("memoAsetFilter", () => {
    const s = cset<number>([1, 2, 3, 4]);
    const p = (x: number) => x % 2 === 0;
    const m = memoAsetFilter(s, p);
    expect(memoAsetFilter(s, p)).toBe(m);
    expect(setSnap(m)).toEqual([2, 4]);
  });

  test("memoAsetChoose", () => {
    const s = cset<number>([1, 2, 3]);
    const f = (x: number) => (x % 2 === 0 ? `e${x}` : undefined);
    const m = memoAsetChoose(s, f);
    expect(memoAsetChoose(s, f)).toBe(m);
    expect(setSnap(m)).toEqual(["e2"]);
  });

  test("memoAsetCollect", () => {
    const s = cset<number>([1, 2]);
    const f = (x: number) => ASet.ofList([x, x * 10]);
    const m = memoAsetCollect(s, f);
    expect(memoAsetCollect(s, f)).toBe(m);
    expect((ASet.force(m).toArray() as number[]).sort((a, b) => a - b)).toEqual([1, 2, 10, 20]);
  });

  test("memoAsetBind", () => {
    const av = cval(0);
    const a = ASet.ofList([1, 2]);
    const b = ASet.ofList([10, 20]);
    const f = (x: number) => (x === 0 ? a : b);
    const m = memoAsetBind(av, f);
    expect(memoAsetBind(av, f)).toBe(m);
    expect(setSnap(m)).toEqual([1, 2]);
    transact(() => {
      av.value = 1;
    });
    expect(setSnap(m)).toEqual([10, 20]);
  });
});

describe("[internal] memoAlist*", () => {
  test("memoAlistMap: hit + miss + behaviour + reactivity", () => {
    const l = clist<number>([1, 2, 3]);
    const f = (x: number) => x + 100;
    const g = (x: number) => x + 100;
    const m = memoAlistMap(l, f);
    expect(memoAlistMap(l, f)).toBe(m);
    expect(memoAlistMap(l, g)).not.toBe(m);
    expect(listSnap(m)).toEqual([101, 102, 103]);
    transact(() => {
      l.add(4);
    });
    expect(listSnap(m)).toEqual([101, 102, 103, 104]);
  });

  test("memoAlistFilter", () => {
    const l = clist<number>([1, 2, 3, 4]);
    const p = (x: number) => x > 2;
    const m = memoAlistFilter(l, p);
    expect(memoAlistFilter(l, p)).toBe(m);
    expect(listSnap(m)).toEqual([3, 4]);
  });

  test("memoAlistChoose", () => {
    const l = clist<number>([1, 2, 3]);
    const f = (x: number) => (x % 2 === 1 ? x * 10 : undefined);
    const m = memoAlistChoose(l, f);
    expect(memoAlistChoose(l, f)).toBe(m);
    expect(listSnap(m)).toEqual([10, 30]);
  });

  test("memoAlistCollect", () => {
    const l = clist<number>([1, 2]);
    const f = (x: number) => AList.ofList([x, -x]);
    const m = memoAlistCollect(l, f);
    expect(memoAlistCollect(l, f)).toBe(m);
    expect(listSnap(m).sort((a, b) => a - b)).toEqual([-2, -1, 1, 2]);
  });

  test("memoAlistBind", () => {
    const av = cval(0);
    const a = AList.ofList([1, 2]);
    const b = AList.ofList([10, 20]);
    const f = (x: number) => (x === 0 ? a : b);
    const m = memoAlistBind(av, f);
    expect(memoAlistBind(av, f)).toBe(m);
    expect(listSnap(m)).toEqual([1, 2]);
    transact(() => {
      av.value = 1;
    });
    expect(listSnap(m)).toEqual([10, 20]);
  });
});

describe("[internal] memoAmap*", () => {
  test("memoAmapMap: hit + miss + behaviour + reactivity", () => {
    const m0 = cmap<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    const f = (_k: string, v: number) => v * 10;
    const g = (_k: string, v: number) => v * 10;
    const mm = memoAmapMap(m0, f);
    expect(memoAmapMap(m0, f)).toBe(mm);
    expect(memoAmapMap(m0, g)).not.toBe(mm);
    expect(mapSnap(mm)).toEqual([
      ["a", 10],
      ["b", 20],
    ]);
    transact(() => {
      m0.add("c", 3);
    });
    expect(mapSnap(mm)).toEqual([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
  });

  test("memoAmapFilter", () => {
    const m0 = cmap<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    const p = (_k: string, v: number) => v > 1;
    const mm = memoAmapFilter(m0, p);
    expect(memoAmapFilter(m0, p)).toBe(mm);
    expect(mapSnap(mm)).toEqual([
      ["b", 2],
      ["c", 3],
    ]);
  });

  test("memoAmapChoose", () => {
    const m0 = cmap<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    const f = (_k: string, v: number) => (v === 2 ? `${v}!` : undefined);
    const mm = memoAmapChoose(m0, f);
    expect(memoAmapChoose(m0, f)).toBe(mm);
    expect(mapSnap(mm)).toEqual([["b", "2!"]]);
  });

  test("memoAmapBind", () => {
    const av = cval(0);
    const a = AMap.ofList<string, number>([["x", 1]]);
    const b = AMap.ofList<string, number>([["y", 2]]);
    const f = (x: number) => (x === 0 ? a : b);
    const mm = memoAmapBind(av, f);
    expect(memoAmapBind(av, f)).toBe(mm);
    expect(mapSnap(mm)).toEqual([["x", 1]]);
    transact(() => {
      av.value = 1;
    });
    expect(mapSnap(mm)).toEqual([["y", 2]]);
  });
});
