// Smoke test for AdaptiveIndexList (clist + AList).

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { AVal } from "../src/adaptiveValue/adaptiveValue.js";
import { IndexList } from "../src/datastructures/indexList.js";
import { AList } from "../src/adaptiveIndexList/adaptiveIndexList.js";
import { clist } from "../src/adaptiveIndexList/changeableIndexList.js";

describe("alist smoke", () => {
  test("empty / constant", () => {
    const e = AList.empty<number>();
    expect(AVal.force(e.content).count).toBe(0);
    const c = AList.ofArray([1, 2, 3]);
    expect([...AVal.force(c.content)]).toEqual([1, 2, 3]);
  });

  test("clist add/remove/perform", () => {
    const l = clist<number>([10, 20, 30]);
    expect(l.currentCount).toBe(3);
    expect([...l]).toEqual([10, 20, 30]);

    const r = l.getReader();
    const initial = r.getChanges(AdaptiveToken.top);
    expect(initial.count).toBe(3);

    transact(() => {
      l.add(40);
      l.removeAt(0);
    });
    expect([...l]).toEqual([20, 30, 40]);

    const delta = r.getChanges(AdaptiveToken.top);
    expect(delta.count).toBe(2);
  });

  test("AList.map / mapi", () => {
    const l = clist<number>([1, 2, 3]);
    const m1 = AList.map((x: number) => x * 10, l);
    const m2 = AList.mapi((_i, x: number) => x + 100, l);
    expect([...AVal.force(m1.content)]).toEqual([10, 20, 30]);
    expect([...AVal.force(m2.content)]).toEqual([101, 102, 103]);

    transact(() => l.add(4));
    expect([...AVal.force(m1.content)]).toEqual([10, 20, 30, 40]);
    expect([...AVal.force(m2.content)]).toEqual([101, 102, 103, 104]);
  });

  test("AList.filter", () => {
    const l = clist<number>([1, 2, 3, 4, 5]);
    const f = AList.filter((x: number) => x % 2 === 0, l);
    expect([...AVal.force(f.content)]).toEqual([2, 4]);
    transact(() => l.add(6));
    expect([...AVal.force(f.content)]).toEqual([2, 4, 6]);
    transact(() => l.removeAt(1)); // removes value 2
    expect([...AVal.force(f.content)]).toEqual([4, 6]);
  });

  test("AList.choose", () => {
    const l = clist<number>([1, 2, 3, 4, 5]);
    const c = AList.choose(
      (x: number) => (x % 2 === 0 ? x * 100 : undefined),
      l,
    );
    expect([...AVal.force(c.content)]).toEqual([200, 400]);
    transact(() => l.add(6));
    expect([...AVal.force(c.content)]).toEqual([200, 400, 600]);
  });

  test("AList.append / concat preserve order", () => {
    const a = clist<number>([1, 2]);
    const b = clist<number>([3, 4]);
    const ab = AList.append(a, b);
    expect([...AVal.force(ab.content)]).toEqual([1, 2, 3, 4]);
    transact(() => a.add(99));
    expect([...AVal.force(ab.content)]).toEqual([1, 2, 99, 3, 4]);

    const cc = AList.concat([a, b, AList.ofArray([100])]);
    expect([...AVal.force(cc.content)]).toEqual([1, 2, 99, 3, 4, 100]);
  });

  test("AList.collect", () => {
    const l = clist<number>([1, 2, 3]);
    const out = AList.collect(
      (x: number) => AList.ofArray([x, x * 10]),
      l,
    );
    expect([...AVal.force(out.content)]).toEqual([1, 10, 2, 20, 3, 30]);
    transact(() => l.add(4));
    expect([...AVal.force(out.content)]).toEqual([1, 10, 2, 20, 3, 30, 4, 40]);
  });

  test("AList.sortBy / sortWith / rev", () => {
    const l = clist<number>([3, 1, 4, 1, 5, 9, 2, 6]);
    const s = AList.sortBy((x: number) => x, l);
    expect([...AVal.force(s.content)]).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    const r = AList.rev(l);
    expect([...AVal.force(r.content)]).toEqual([6, 2, 9, 5, 1, 4, 1, 3]);
  });

  test("AList.pairwise / pairwiseCyclic", () => {
    const l = AList.ofArray([1, 2, 3, 4]);
    const p = AList.pairwise(l);
    expect([...AVal.force(p.content)]).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    const pc = AList.pairwiseCyclic(l);
    expect([...AVal.force(pc.content)]).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 1],
    ]);
  });

  test("AList.bind", () => {
    const l = clist<number>([1, 2]);
    const flag = AVal.constant(true);
    const out = AList.bind((b: boolean) => (b ? l : AList.empty<number>()), flag);
    expect([...AVal.force(out.content)]).toEqual([1, 2]);
  });

  test("AList.reduce / sum / count", () => {
    const l = clist<number>([1, 2, 3, 4]);
    expect(AVal.force(AList.sum(l))).toBe(10);
    expect(AVal.force(AList.count(l))).toBe(4);
    expect(AVal.force(AList.isEmpty(l))).toBe(false);
    transact(() => l.clear());
    expect(AVal.force(AList.sum(l))).toBe(0);
    expect(AVal.force(AList.isEmpty(l))).toBe(true);
  });

  test("AList.tryFirst / tryLast / tryAt", () => {
    const l = clist<number>([10, 20, 30]);
    expect(AVal.force(AList.tryFirst(l))).toBe(10);
    expect(AVal.force(AList.tryLast(l))).toBe(30);
    expect(AVal.force(AList.tryAt(1, l))).toBe(20);
    expect(AVal.force(AList.tryAt(99, l))).toBe(undefined);
  });

  test("clist updateTo computes minimal diff", () => {
    const l = clist<number>([1, 2, 3]);
    const r = l.getReader();
    r.getChanges(AdaptiveToken.top);

    transact(() => l.updateTo(IndexList.ofArray([1, 2, 3, 4])));
    const delta = r.getChanges(AdaptiveToken.top);
    expect(delta.count).toBe(1);
  });
});
