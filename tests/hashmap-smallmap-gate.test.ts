// Small-map gate (scene-templates M2): pins HashMap behavior in the
// size range a small-map representation would cover (0..24 entries,
// hammering the promotion boundary), model-tested against a plain JS
// Map oracle — including collision-heavy keys and the delta layer
// (which the amap readers ride). This suite must stay green,
// unchanged, across the small-map optimization.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import {
  HashMap, HashMapDeltaExt,
} from "../src/index.js";

// Collision-heavy key: many distinct keys share few hash values.
class CollKey {
  constructor(readonly id: number) {}
  getHashCode(): number { return this.id % 5; }
  equals(o: unknown): boolean { return o instanceof CollKey && o.id === this.id; }
  toString(): string { return `ck${this.id}`; }
}

type Op =
  | { t: "add"; k: number; v: number }
  | { t: "remove"; k: number }
  | { t: "alter"; k: number; toV: number | undefined };

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("add" as const), k: fc.integer({ min: 0, max: 30 }), v: fc.integer() }),
  fc.record({ t: fc.constant("remove" as const), k: fc.integer({ min: 0, max: 30 }) }),
  fc.record({
    t: fc.constant("alter" as const),
    k: fc.integer({ min: 0, max: 30 }),
    toV: fc.option(fc.integer(), { nil: undefined }),
  }),
);

const arbOps = fc.array(arbOp, { maxLength: 60 });

function runModel(
  ops: Op[],
  mkKey: (k: number) => unknown,
  keyId: (k: unknown) => number,
): void {
  let m = HashMap.empty<unknown, number>();
  const model = new Map<number, number>();
  for (const op of ops) {
    if (op.t === "add") {
      m = m.add(mkKey(op.k), op.v);
      model.set(op.k, op.v);
    } else if (op.t === "remove") {
      const before = m;
      m = m.remove(mkKey(op.k));
      if (!model.has(op.k)) {
        // identity contract: removing a missing key returns the SAME map
        expect(m).toBe(before);
      }
      model.delete(op.k);
    } else {
      m = m.alter(mkKey(op.k), (_ex) => op.toV);
      if (op.toV === undefined) model.delete(op.k);
      else model.set(op.k, op.toV);
    }
    // full-state agreement after EVERY op
    expect(m.count).toBe(model.size);
    expect(m.isEmpty).toBe(model.size === 0);
    for (const [k, v] of model) {
      expect(m.tryFind(mkKey(k))).toBe(v);
      expect(m.containsKey(mkKey(k))).toBe(true);
    }
    let seen = 0;
    for (const [k, v] of m) {
      expect(model.get(keyId(k))).toBe(v);
      seen++;
    }
    expect(seen).toBe(model.size);
  }
}

describe("small-map gate — model agreement", () => {
  test("integer keys", () => {
    fc.assert(fc.property(arbOps, (ops) => {
      runModel(ops, (k) => k, (k) => k as number);
    }), { numRuns: 300 });
  });

  test("collision-heavy keys", () => {
    fc.assert(fc.property(arbOps, (ops) => {
      runModel(ops, (k) => new CollKey(k), (k) => (k as CollKey).id);
    }), { numRuns: 300 });
  });
});

describe("small-map gate — derived ops agree with entry semantics", () => {
  const arbEntries = fc.array(
    fc.tuple(fc.integer({ min: 0, max: 24 }), fc.integer()),
    { maxLength: 24 },
  );

  function ofEntries(es: [number, number][]): HashMap<number, number> {
    let m = HashMap.empty<number, number>();
    for (const [k, v] of es) m = m.add(k, v);
    return m;
  }
  function modelOf(es: [number, number][]): Map<number, number> {
    const model = new Map<number, number>();
    for (const [k, v] of es) model.set(k, v);
    return model;
  }

  test("map / filter / choose / fold / exists / forall / toArray", () => {
    fc.assert(fc.property(arbEntries, (es) => {
      const m = ofEntries(es);
      const model = modelOf(es);
      const mapped = m.map((k, v) => k + v);
      expect(mapped.count).toBe(model.size);
      for (const [k, v] of model) expect(mapped.tryFind(k)).toBe(k + v);
      const filtered = m.filter((k, _v) => k % 2 === 0);
      expect(filtered.count).toBe([...model.keys()].filter((k) => k % 2 === 0).length);
      const chosen = m.choose((k, v) => (v % 2 === 0 ? k * v : undefined));
      for (const [k, v] of model) {
        expect(chosen.tryFind(k)).toBe(v % 2 === 0 ? k * v : undefined);
      }
      const sum = m.fold((s, _k, v) => s + v, 0);
      expect(sum).toBe([...model.values()].reduce((a, b) => a + b, 0));
      expect(m.exists((_k, v) => v > 0)).toBe([...model.values()].some((v) => v > 0));
      expect(m.forall((_k, v) => v !== 42)).toBe([...model.values()].every((v) => v !== 42));
    }), { numRuns: 300 });
  });

  test("unionWith / choose2V across representation sizes", () => {
    fc.assert(fc.property(arbEntries, arbEntries, (ae, be) => {
      const a = ofEntries(ae);
      const b = ofEntries(be);
      const ma = modelOf(ae);
      const mb = modelOf(be);
      const u = a.unionWith(b, (_k, x, y) => x + y);
      const keys = new Set([...ma.keys(), ...mb.keys()]);
      expect(u.count).toBe(keys.size);
      for (const k of keys) {
        const x = ma.get(k);
        const y = mb.get(k);
        const want = x !== undefined && y !== undefined ? x + y : (x ?? y);
        expect(u.tryFind(k)).toBe(want);
      }
      const z = a.choose2V(b, (_k, x, y) => (x ?? 0) + (y ?? 0));
      for (const k of keys) {
        expect(z.tryFind(k)).toBe((ma.get(k) ?? 0) + (mb.get(k) ?? 0));
      }
    }), { numRuns: 200 });
  });

  test("delta round-trip: applyDelta(a, computeDelta(a,b)) == b", () => {
    fc.assert(fc.property(arbEntries, arbEntries, (ae, be) => {
      const a = ofEntries(ae);
      const b = ofEntries(be);
      const d = HashMapDeltaExt.computeDelta(a, b);
      const { state } = HashMapDeltaExt.applyDelta(a, d);
      expect(state.count).toBe(b.count);
      for (const [k, v] of b) expect(state.tryFind(k)).toBe(v);
      // self-delta is empty
      const self = HashMapDeltaExt.computeDelta(a, a);
      expect(self.isEmpty).toBe(true);
    }), { numRuns: 200 });
  });
});
