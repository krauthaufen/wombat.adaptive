// Dict<K, V> — the mutable .NET-style hash table backing reader
// caches. Model-tested against a plain JS Map oracle, including
// collision-heavy keys, freelist reuse across grow, and the
// single-probe alter/getOrAdd semantics.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Dict } from "../src/datastructures/dict.js";

class CollKey {
  constructor(readonly id: number) {}
  getHashCode(): number { return this.id % 5; }
  equals(o: unknown): boolean { return o instanceof CollKey && o.id === this.id; }
}

/** Key whose hash is negative — exercises sign handling in masking. */
class NegKey {
  constructor(readonly id: number) {}
  getHashCode(): number { return -(this.id + 1); }
  equals(o: unknown): boolean { return o instanceof NegKey && o.id === this.id; }
}

type Op =
  | { t: "set"; k: number; v: number }
  | { t: "remove"; k: number }
  | { t: "alter"; k: number; toV: number | undefined }
  | { t: "getOrAdd"; k: number; v: number };

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("set" as const), k: fc.integer({ min: 0, max: 40 }), v: fc.integer() }),
  fc.record({ t: fc.constant("remove" as const), k: fc.integer({ min: 0, max: 40 }) }),
  fc.record({
    t: fc.constant("alter" as const),
    k: fc.integer({ min: 0, max: 40 }),
    toV: fc.option(fc.integer(), { nil: undefined }),
  }),
  fc.record({ t: fc.constant("getOrAdd" as const), k: fc.integer({ min: 0, max: 40 }), v: fc.integer() }),
);

function runModel(ops: Op[], mkKey: (k: number) => unknown): void {
  const d = new Dict<unknown, number>();
  const model = new Map<number, number>();
  for (const op of ops) {
    if (op.t === "set") {
      d.set(mkKey(op.k), op.v);
      model.set(op.k, op.v);
    } else if (op.t === "remove") {
      const removed = d.remove(mkKey(op.k));
      expect(removed).toBe(model.get(op.k));
      model.delete(op.k);
    } else if (op.t === "alter") {
      let seen: number | undefined = -999;
      d.alter(mkKey(op.k), (v) => { seen = v; return op.toV; });
      expect(seen).toBe(model.get(op.k));
      if (op.toV === undefined) model.delete(op.k);
      else model.set(op.k, op.toV);
    } else {
      const got = d.getOrAdd(mkKey(op.k), () => op.v);
      if (model.has(op.k)) expect(got).toBe(model.get(op.k));
      else { expect(got).toBe(op.v); model.set(op.k, op.v); }
    }
    expect(d.count).toBe(model.size);
    // spot-probe a few keys
    for (const k of [0, 7, 40]) {
      expect(d.tryGet(mkKey(k))).toBe(model.get(k));
      expect(d.has(mkKey(k))).toBe(model.has(k));
    }
  }
  // full sweep: iteration matches the model exactly
  const seen = new Map<number, number>();
  for (const [k, v] of d) {
    const id = typeof k === "string"
      ? Number(k.slice(4))
      : (k as { id?: number }).id ?? (k as number);
    expect(seen.has(id)).toBe(false);
    seen.set(id, v);
  }
  expect(seen.size).toBe(model.size);
  for (const [k, v] of model) expect(seen.get(k)).toBe(v);
}

describe("Dict — model tests", () => {
  test("plain number keys", () => {
    fc.assert(fc.property(fc.array(arbOp, { maxLength: 200 }), (ops) => {
      runModel(ops, (k) => k);
    }), { numRuns: 300 });
  });

  test("collision-heavy keys", () => {
    fc.assert(fc.property(fc.array(arbOp, { maxLength: 200 }), (ops) => {
      runModel(ops, (k) => new CollKey(k));
    }), { numRuns: 300 });
  });

  test("negative-hash keys", () => {
    fc.assert(fc.property(fc.array(arbOp, { maxLength: 120 }), (ops) => {
      runModel(ops, (k) => new NegKey(k));
    }), { numRuns: 200 });
  });

  test("string keys", () => {
    fc.assert(fc.property(fc.array(arbOp, { maxLength: 120 }), (ops) => {
      runModel(ops, (k) => `key-${k}`);
    }), { numRuns: 200 });
  });

  test("grow across freelist holes keeps chains intact", () => {
    const d = new Dict<number, number>(8);
    for (let i = 0; i < 6; i++) d.set(i, i * 10);
    for (let i = 0; i < 6; i += 2) d.remove(i);   // punch holes
    for (let i = 100; i < 140; i++) d.set(i, i);  // force several grows
    expect(d.count).toBe(3 + 40);
    for (let i = 1; i < 6; i += 2) expect(d.tryGet(i)).toBe(i * 10);
    for (let i = 100; i < 140; i++) expect(d.tryGet(i)).toBe(i);
    for (let i = 0; i < 6; i += 2) expect(d.tryGet(i)).toBeUndefined();
  });

  test("clear resets fully and stays usable", () => {
    const d = new Dict<string, number>();
    for (let i = 0; i < 50; i++) d.set(`k${i}`, i);
    d.clear();
    expect(d.count).toBe(0);
    expect(d.tryGet("k3")).toBeUndefined();
    d.set("a", 1);
    expect(d.tryGet("a")).toBe(1);
    expect(d.count).toBe(1);
  });
});
