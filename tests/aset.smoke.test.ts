// Smoke test for the phase-4 ASet/cset machinery.

import { describe, expect, test } from "vitest";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { transact } from "../src/core/transaction.js";
import { HashSet } from "../src/datastructures/hashCollections.js";
import { AVal } from "../src/adaptiveValue/adaptiveValue.js";
import { ASet } from "../src/adaptiveHashSet/adaptiveHashSet.js";
import { cset } from "../src/adaptiveHashSet/changeableHashSet.js";

describe("aset smoke", () => {
  test("empty / constant", () => {
    const e = ASet.empty<number>();
    expect(AVal.force(e.content).count).toBe(0);

    const c = ASet.ofArray([1, 2, 3]);
    const set = AVal.force(c.content);
    expect(set.count).toBe(3);
    expect(set.contains(2)).toBe(true);
  });

  test("cset basic add/remove and reader pulls deltas", () => {
    const s = cset<number>([1, 2, 3]);
    expect(s.currentCount).toBe(3);
    expect(s.containsNow(2)).toBe(true);

    const r = s.getReader();
    const t = AdaptiveToken.top;
    const initial = r.getChanges(t);
    // initial pull from empty -> {1,2,3}
    expect(initial.count).toBe(3);
    for (const op of initial) {
      expect(op.count).toBe(1);
    }

    transact(() => {
      s.add(4);
      s.remove(1);
    });

    const t2 = AdaptiveToken.top;
    const delta = r.getChanges(t2);
    const ops = [...delta];
    expect(ops.length).toBe(2);
    const adds = ops.filter((o) => o.count === 1).map((o) => o.value);
    const rems = ops.filter((o) => o.count === -1).map((o) => o.value);
    expect(adds).toEqual([4]);
    expect(rems).toEqual([1]);
  });

  test("cset.updateTo computes minimal diff", () => {
    const s = cset<number>([1, 2, 3]);
    const r = s.getReader();
    r.getChanges(AdaptiveToken.top);

    transact(() => {
      s.updateTo(HashSet.ofArray([2, 3, 4]));
    });

    const delta = r.getChanges(AdaptiveToken.top);
    const ops = [...delta];
    expect(ops.length).toBe(2);
    const adds = ops.filter((o) => o.count === 1).map((o) => o.value);
    const rems = ops.filter((o) => o.count === -1).map((o) => o.value);
    expect(adds).toEqual([4]);
    expect(rems).toEqual([1]);
  });

  test("ASet.map reflects upstream changes", () => {
    const s = cset<number>([1, 2, 3]);
    const mapped = ASet.map((x: number) => x * 10, s);
    const r = mapped.getReader();

    const t1 = AdaptiveToken.top;
    const initial = [...r.getChanges(t1)].map((o) => o.value).sort((a, b) => a - b);
    expect(initial).toEqual([10, 20, 30]);

    transact(() => {
      s.add(4);
    });
    const t2 = AdaptiveToken.top;
    const next = [...r.getChanges(t2)];
    expect(next.length).toBe(1);
    expect(next[0]!.value).toBe(40);
    expect(next[0]!.count).toBe(1);
  });

  test("ASet.union", () => {
    const a = cset<number>([1, 2]);
    const b = cset<number>([2, 3]);
    const u = ASet.union(a, b);

    const set = AVal.force(u.content);
    expect(set.count).toBe(3);
    expect(set.contains(1) && set.contains(2) && set.contains(3)).toBe(true);
  });

  test("cset content as aval reflects mutations", () => {
    const s = cset<number>();
    const v = s.content;
    expect(AVal.force(v).count).toBe(0);
    transact(() => {
      s.add(42);
      s.add(7);
    });
    const set = AVal.force(v);
    expect(set.count).toBe(2);
    expect(set.contains(42)).toBe(true);
    expect(set.contains(7)).toBe(true);
  });
});
