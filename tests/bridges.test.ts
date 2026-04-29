// Cross-collection bridge tests.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AVal } from "../src/adaptiveValue/adaptiveValue.js";
import { cset } from "../src/adaptiveHashSet/changeableHashSet.js";
import { cmap } from "../src/adaptiveHashMap/changeableHashMap.js";
import { clist } from "../src/adaptiveIndexList/changeableIndexList.js";
import { AMap } from "../src/adaptiveHashMap/adaptiveHashMap.js";
import {
  ASetBridges,
  AMapBridges,
  AListBridges,
} from "../src/collectionExtensions/bridges.js";

describe("bridges: ASet ↔ AList", () => {
  test("ASet.toAList — initial + add/remove", () => {
    const s = cset<number>([3, 1, 2]);
    const l = ASetBridges.toAList(s);
    expect([...AVal.force(l.content)].sort()).toEqual([1, 2, 3]);
    transact(() => s.add(99));
    expect([...AVal.force(l.content)].sort()).toEqual([1, 2, 3, 99]);
    transact(() => s.remove(1));
    expect([...AVal.force(l.content)].sort()).toEqual([2, 3, 99]);
  });

  test("ASet.sortBy", () => {
    const s = cset<number>([3, 1, 4, 1, 5, 9, 2, 6]);
    const sorted = ASetBridges.sortBy((x: number) => x, s);
    expect([...AVal.force(sorted.content)]).toEqual([1, 2, 3, 4, 5, 6, 9]);
    transact(() => s.add(0));
    expect([...AVal.force(sorted.content)]).toEqual([0, 1, 2, 3, 4, 5, 6, 9]);
  });

  test("ASet.sortDescending", () => {
    const s = cset<number>([3, 1, 4]);
    const desc = ASetBridges.sortDescending<number>(s);
    expect([...AVal.force(desc.content)]).toEqual([4, 3, 1]);
  });

  test("ASet.sortBy with duplicate projections (Unique disambiguation)", () => {
    const s = cset<{ k: string; n: number }>([
      { k: "a", n: 1 },
      { k: "b", n: 2 },
      { k: "c", n: 1 },
    ]);
    const sorted = ASetBridges.sortBy<{ k: string; n: number }, number>(
      (x) => x.n,
      s,
    );
    const out = [...AVal.force(sorted.content)].map((x) => x.k);
    expect(out.sort()).toEqual(["a", "b", "c"]);
  });

  test("ASet.sortWith strict ordering", () => {
    // Note: like F#'s SetSortWithReader, a comparator returning 0 for
    // distinct elements collapses them to the same output index — use
    // sortBy + Unique-wrapped projection if you need stable disambiguation.
    const s = cset<{ k: string; n: number }>([
      { k: "a", n: 3 },
      { k: "b", n: 1 },
      { k: "c", n: 2 },
    ]);
    const sorted = ASetBridges.sortWith<{ k: string; n: number }>(
      (a, b) => a.n - b.n,
      s,
    );
    const out = [...AVal.force(sorted.content)].map((x) => x.k);
    expect(out).toEqual(["b", "c", "a"]);
  });

  test("ASet.groupBy", () => {
    const s = cset<number>([1, 2, 3, 4, 5, 6]);
    const grouped = ASetBridges.groupBy((x: number) => x % 2, s);
    const m = AVal.force(grouped.content);
    expect(m.tryFind(0)?.toList().sort()).toEqual([2, 4, 6]);
    expect(m.tryFind(1)?.toList().sort()).toEqual([1, 3, 5]);
  });
});

describe("bridges: AList ↔ ASet/AMap", () => {
  test("AList.toASet reflects mutations", () => {
    const l = clist<number>([1, 2, 3]);
    const s = AListBridges.toASet(l);
    expect([...AVal.force(s.content)].sort()).toEqual([1, 2, 3]);
    transact(() => l.add(4));
    expect([...AVal.force(s.content)].sort()).toEqual([1, 2, 3, 4]);
  });

  test("AList.mapToASet caches", () => {
    const l = clist<number>([1, 2, 3]);
    let calls = 0;
    const s = AListBridges.mapToASet((x: number) => {
      calls += 1;
      return x * 10;
    }, l);
    expect([...AVal.force(s.content)].sort()).toEqual([10, 20, 30]);
    expect(calls).toBe(3);
    transact(() => l.add(4));
    expect([...AVal.force(s.content)].sort()).toEqual([10, 20, 30, 40]);
    expect(calls).toBe(4);
  });

  test("AList.toAMap / ofAMap round-trip", () => {
    const l = clist<number>([10, 20, 30]);
    const m = AListBridges.toAMap(l);
    const back = AListBridges.ofAMap(m);
    expect([...AVal.force(back.content)]).toEqual([10, 20, 30]);
    transact(() => l.add(40));
    expect([...AVal.force(back.content)]).toEqual([10, 20, 30, 40]);
  });
});

describe("bridges: AMap ↔ AList", () => {
  test("AMap.sortBy ordering reacts to mutations", () => {
    const m = cmap<string, number>([
      ["a", 3],
      ["b", 1],
      ["c", 2],
    ]);
    const sorted = AMapBridges.sortBy<string, number, number>(
      (_k, v) => v,
      m,
    );
    expect(
      [...AVal.force(sorted.content)].map(([k, _v]) => k),
    ).toEqual(["b", "c", "a"]);

    transact(() => m.set("a", 0));
    expect(
      [...AVal.force(sorted.content)].map(([k, _v]) => k),
    ).toEqual(["a", "b", "c"]);
  });

  test("AMap.keys", () => {
    const m = cmap<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    const k = AMap.toASet(m);
    expect(AVal.force(k.content).count).toBe(2);
    transact(() => m.add("c", 3));
    expect(AVal.force(k.content).count).toBe(3);
    transact(() => m.remove("a"));
    expect(AVal.force(k.content).count).toBe(2);
  });
});
