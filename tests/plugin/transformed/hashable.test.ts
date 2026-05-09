// Behavioural test: closure-captured value-typed objects with
// `getHashCode` + `equals` (the wombat.base convention for V3f / M44f
// / V3i / etc.) dedupe by structural value. Two distinct instances
// carrying the same data, captured by two structurally-identical
// callbacks, share one cache entry.
//
// wombat.adaptive doesn't depend on wombat.base, so this test
// declares a local stand-in class with the same duck-type shape.

import { describe, expect, test } from "vitest";
import { cval } from "@aardworx/wombat.adaptive/aval";

// V3f-shaped local stand-in. Structurally equal instances return the
// same `getHashCode()` and `equals()` true.
class V3 {
  constructor(readonly x: number, readonly y: number, readonly z: number) {}
  getHashCode(): number {
    // Tiny hash; collisions don't matter for the small set of values
    // these tests use.
    let h = this.x | 0;
    h = (h * 31 + (this.y | 0)) | 0;
    h = (h * 31 + (this.z | 0)) | 0;
    return h;
  }
  equals(o: unknown): boolean {
    return o instanceof V3 && o.x === this.x && o.y === this.y && o.z === this.z;
  }
}

// Plain object — same data fields, but no getHashCode/equals. Falls
// through to reference identity in the runtime.
type PlainV3 = { x: number; y: number; z: number };

// Helper closes over `v` so the lambda body and free vars stay
// IDENTICAL across calls — only the captured V3 instance differs.
// (Two lambdas at distinct call sites with the same source text but
// different captures is exactly the case the plugin's body-hash +
// closure-deps emit is designed for.)
const av = cval(1);
function mapWith(v: V3) {
  return av.map((t) => t * (v.x + v.y + v.z));
}
function mapWithPlain(v: PlainV3) {
  return av.map((t) => t * (v.x + v.y + v.z));
}

describe("[plugin/behavioural] hashable closure deps", () => {
  test("two equal V3 instances captured by the same lambda → same derived", () => {
    const a = new V3(1, 2, 3);
    const b = new V3(1, 2, 3);
    expect(a).not.toBe(b);                  // distinct instances
    const m1 = mapWith(a);
    const m2 = mapWith(b);
    expect(m1).toBe(m2);                    // structural-hash dedup
  });

  test("two V3 instances with DIFFERENT data → different derived", () => {
    const a = new V3(1, 2, 3);
    const b = new V3(4, 5, 6);
    expect(mapWith(a)).not.toBe(mapWith(b));
  });

  test("plain objects with primitive leaves intern by structure", () => {
    const a: PlainV3 = { x: 1, y: 2, z: 3 };
    const b: PlainV3 = { x: 1, y: 2, z: 3 };
    expect(a).not.toBe(b);
    // §5d Fix 5: simple plain objects (own enumerable keys, primitive
    // leaves, depth-bounded) intern via the runtime's SIMPLE_INTERN
    // map. Two structurally-equal `{x,y,z}` literals captured at
    // distinct call sites collapse to one cache entry.
    expect(mapWithPlain(a)).toBe(mapWithPlain(b));
  });

  test("plain objects with different data → distinct cache entries", () => {
    const a: PlainV3 = { x: 1, y: 2, z: 3 };
    const b: PlainV3 = { x: 4, y: 5, z: 6 };
    expect(mapWithPlain(a)).not.toBe(mapWithPlain(b));
  });

  test("plain arrays of primitives intern by structure", () => {
    function mapWithArr(arr: readonly number[]) {
      return av.map((t) => t + arr[0]! + arr[1]!);
    }
    const a = [10, 20];
    const b = [10, 20];
    expect(a).not.toBe(b);
    expect(mapWithArr(a)).toBe(mapWithArr(b));

    const c = [10, 21];
    expect(mapWithArr(a)).not.toBe(mapWithArr(c));
  });

  test("nested simple containers intern by structure (within depth limit)", () => {
    function mapWithCfg(cfg: { axis: { x: number; y: number } }) {
      return av.map((t) => t + cfg.axis.x);
    }
    const a = { axis: { x: 1, y: 2 } };
    const b = { axis: { x: 1, y: 2 } };
    expect(mapWithCfg(a)).toBe(mapWithCfg(b));
  });

  test("class instance without getHashCode/equals falls through to reference identity", () => {
    class Bag {
      constructor(public n: number) {}
    }
    function mapWithBag(bag: Bag) {
      return av.map((t) => t + bag.n);
    }
    const a = new Bag(5);
    const b = new Bag(5);
    // Bag has its own prototype (not Object.prototype) — not "simple",
    // not Hashable. Reference identity rules; distinct cache entries.
    expect(mapWithBag(a)).not.toBe(mapWithBag(b));
    // Same instance reused → trivially shared.
    expect(mapWithBag(a)).toBe(mapWithBag(a));
  });

  test("same V3 instance reused → trivially shared", () => {
    const v = new V3(1, 2, 3);
    expect(mapWith(v)).toBe(mapWith(v));
  });

  test("collision-resistant: same hashCode but different data → different derived", () => {
    // Adversarial V3 subclass that always returns 0 from getHashCode —
    // forces a collision. The cache key includes toString, so
    // structurally-distinct values still get distinct entries.
    class V3Coll extends V3 {
      override getHashCode(): number { return 0; }
    }
    const a = new V3Coll(1, 2, 3);
    const b = new V3Coll(4, 5, 6);
    expect(a.getHashCode()).toBe(b.getHashCode());  // forced collision
    expect(mapWith(a)).not.toBe(mapWith(b));         // still distinguished
  });
});
