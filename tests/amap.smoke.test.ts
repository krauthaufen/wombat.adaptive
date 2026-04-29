// Smoke test for AdaptiveHashMap (cmap + AMap).

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { AVal } from "../src/adaptiveValue/adaptiveValue.js";
import { HashMap } from "../src/datastructures/hashCollections.js";
import { AMap } from "../src/adaptiveHashMap/adaptiveHashMap.js";
import { cmap } from "../src/adaptiveHashMap/changeableHashMap.js";

describe("amap smoke", () => {
  test("empty / constant", () => {
    const e = AMap.empty<number, number>();
    expect(AVal.force(e.content).count).toBe(0);
    const c = AMap.ofArray<number, string>([
      [1, "a"],
      [2, "b"],
    ]);
    expect(AVal.force(c.content).count).toBe(2);
  });

  test("cmap basic add/remove and reader pulls deltas", () => {
    const m = cmap<number, number>([
      [1, 10],
      [2, 20],
    ]);
    expect(m.count).toBe(2);
    expect(m.containsKey(1)).toBe(true);

    const r = m.getReader();
    const initial = r.getChanges(AdaptiveToken.top);
    expect(initial.count).toBe(2);

    transact(() => {
      m.add(3, 30);
      m.remove(1);
    });

    const delta = r.getChanges(AdaptiveToken.top);
    const ops = [...delta];
    expect(ops.length).toBe(2);
    const sets = ops.filter(([_, op]) => op.tag === "Set");
    const rems = ops.filter(([_, op]) => op.tag === "Remove");
    expect(sets.map(([k]) => k)).toEqual([3]);
    expect(rems.map(([k]) => k)).toEqual([1]);
  });

  test("AMap.map reflects mutations", () => {
    const m = cmap<number, number>([
      [1, 10],
      [2, 20],
    ]);
    const mapped = AMap.map((_k: number, v: number) => v + 1, m);
    expect(AVal.force(mapped.content).tryFind(1)).toBe(11);

    transact(() => m.add(3, 30));
    expect(AVal.force(mapped.content).tryFind(3)).toBe(31);
    expect(AVal.force(mapped.content).count).toBe(3);
  });

  test("AMap.union with right-bias", () => {
    const a = cmap<number, string>([[1, "a"], [2, "b"]]);
    const b = cmap<number, string>([[2, "B"], [3, "C"]]);
    const u = AMap.union(a, b);
    const m = AVal.force(u.content);
    expect(m.count).toBe(3);
    expect(m.tryFind(1)).toBe("a");
    expect(m.tryFind(2)).toBe("B");
    expect(m.tryFind(3)).toBe("C");
  });

  test("AMap.toASet adds and removes correctly", () => {
    const m = cmap<number, string>([[1, "a"], [2, "b"]]);
    const s = AMap.toASet(m);
    expect(AVal.force(s.content).count).toBe(2);

    transact(() => m.add(3, "c"));
    expect(AVal.force(s.content).count).toBe(3);

    transact(() => m.remove(1));
    expect(AVal.force(s.content).count).toBe(2);
  });

  test("AMap.toASetValues distinct", () => {
    const m = cmap<number, string>([[1, "a"], [2, "b"], [3, "a"]]);
    const s = AMap.toASetValues(m);
    expect(AVal.force(s.content).count).toBe(2);
  });

  test("AMap.tryFind / find", () => {
    const m = cmap<number, number>([[1, 10]]);
    const v = AMap.tryFind(1, m);
    expect(AVal.force(v)).toBe(10);
    expect(AVal.force(AMap.tryFind(99, m))).toBe(undefined);
  });

  test("AMap.count and AMap.isEmpty", () => {
    const m = cmap<number, number>();
    expect(AVal.force(AMap.isEmpty(m))).toBe(true);
    expect(AVal.force(AMap.count(m))).toBe(0);
    transact(() => {
      m.add(1, 1);
      m.add(2, 2);
    });
    expect(AVal.force(AMap.isEmpty(m))).toBe(false);
    expect(AVal.force(AMap.count(m))).toBe(2);
  });

  test("AMap.updateTo computes minimal diff", () => {
    const m = cmap<number, number>([[1, 1], [2, 2]]);
    const r = m.getReader();
    r.getChanges(AdaptiveToken.top);

    transact(() =>
      m.updateTo(HashMap.ofArray<number, number>([[2, 2], [3, 3]])),
    );

    const delta = r.getChanges(AdaptiveToken.top);
    const ops = [...delta];
    expect(ops.length).toBe(2);
    const adds = ops.filter(([_, op]) => op.tag === "Set").map(([k]) => k);
    const rems = ops.filter(([_, op]) => op.tag === "Remove").map(([k]) => k);
    expect(adds).toEqual([3]);
    expect(rems).toEqual([1]);
  });
});
