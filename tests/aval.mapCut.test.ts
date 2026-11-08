// AVal.mapCut: a map whose readers are marked only when its value changed.
import { describe, expect, test } from "vitest";
import { AVal } from "../src/adaptiveValue/adaptiveValue.js";
import { transact } from "../src/core/transaction.js";

describe("[AVal.mapCut]", () => {
  test("an unchanged result does not mark its readers", () => {
    const row = AVal.init({ a: 1, b: 10 });
    const a = AVal.mapCut(row, (r) => r.a);
    const b = AVal.mapCut(row, (r) => r.b);
    let ra = 0;
    let rb = 0;
    const da = a.map((x) => { ra++; return x * 2; });
    const db = b.map((x) => { rb++; return x * 2; });
    expect(da.force()).toBe(2);
    expect(db.force()).toBe(20);
    transact(() => { row.value = { a: 2, b: 10 }; });
    expect(da.outOfDate).toBe(true);
    expect(db.outOfDate).toBe(false);
    expect(da.force()).toBe(4);
    expect(db.force()).toBe(20);
    expect([ra, rb]).toEqual([2, 1]);
  });

  test("the mapping runs once per change of the input", () => {
    const x = AVal.init(1);
    let runs = 0;
    const c = AVal.mapCut(x, (v) => { runs++; return v % 2; });
    const d = c.map((v) => v + 1);
    expect(d.force()).toBe(2);
    transact(() => { x.value = 3; });
    expect(d.outOfDate).toBe(false);
    expect(d.force()).toBe(2);
    transact(() => { x.value = 4; });
    expect(d.force()).toBe(1);
    expect(runs).toBe(3);
  });

  test("structural equality (equals / getHashCode) by default, or a given one", () => {
    class P {
      constructor(readonly x: number) {}
      equals(o: unknown) { return o instanceof P && o.x === this.x; }
      getHashCode() { return this.x; }
    }
    const x = AVal.init(1);
    const p = AVal.mapCut(x, (v) => new P(Math.sign(v)));
    const q = AVal.mapCut(x, (v) => [Math.sign(v)], (a, b) => a[0] === b[0]);
    const dp = p.map((v) => v.x);
    const dq = q.map((v) => v[0]);
    expect(dp.force()).toBe(1);
    expect(dq.force()).toBe(1);
    transact(() => { x.value = 5; });
    expect(dp.outOfDate).toBe(false);
    expect(dq.outOfDate).toBe(false);
    transact(() => { x.value = -5; });
    expect(dp.force()).toBe(-1);
    expect(dq.force()).toBe(-1);
  });

  test("a cut deep in a chain: readers below see only real changes", () => {
    const x = AVal.init(0);
    const y = AVal.init(0);
    const sum = AVal.zip(x, y).map((a, b) => a + b);
    const sign = AVal.mapCut(sum, (s) => s >= 0);
    let reads = 0;
    const out = AVal.zip(sign, y).map((s, b) => { reads++; return s ? b : -b; });
    expect(out.force()).toBe(0);
    transact(() => { x.value = 5; });
    expect(out.outOfDate).toBe(false);
    transact(() => { x.value = -10; y.value = 1; });
    expect(out.force()).toBe(-1);
    expect(reads).toBe(2);
  });

  test("a failing mapping is raised where read, and marks its readers", () => {
    const x = AVal.init(1);
    const c = AVal.mapCut(x, (v) => { if (v < 0) throw new Error("neg"); return v; });
    const d = c.map((v) => v);
    expect(d.force()).toBe(1);
    transact(() => { x.value = -1; });
    expect(d.outOfDate).toBe(true);
    expect(() => d.force()).toThrow("neg");
    transact(() => { x.value = 2; });
    expect(d.force()).toBe(2);
  });

  test("callbacks fire only for changes", () => {
    const x = AVal.init(1);
    const c = AVal.mapCut(x, (v) => v > 0);
    const seen: boolean[] = [];
    const sub = c.addCallback((v) => seen.push(v));
    transact(() => { x.value = 2; });
    transact(() => { x.value = -2; });
    transact(() => { x.value = -3; });
    sub.dispose();
    expect(seen).toEqual([true, false]);
  });

  test("a constant input is a constant", () => {
    const c = AVal.mapCut(AVal.constant(3), (v) => v + 1);
    expect(c.isConstant).toBe(true);
    expect(c.force()).toBe(4);
  });
});
