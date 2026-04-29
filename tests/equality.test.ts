// Verify the user-defined `equals` / `getHashCode` convention.

import { describe, expect, test } from "vitest";
import {
  defaultEquals,
  defaultHash,
} from "../src/datastructures/equality.js";
import { HashMap, HashSet } from "../src/datastructures/hashCollections.js";

class Pair {
  constructor(
    readonly a: number,
    readonly b: number,
  ) {}
  equals(other: unknown): boolean {
    return other instanceof Pair && other.a === this.a && other.b === this.b;
  }
  getHashCode(): number {
    return ((this.a | 0) * 31 + (this.b | 0)) | 0;
  }
}

class IdentityOnly {
  constructor(readonly v: number) {}
}

describe("equality convention", () => {
  test("custom equals/getHashCode is consulted for objects", () => {
    const p1 = new Pair(1, 2);
    const p2 = new Pair(1, 2);
    const p3 = new Pair(3, 4);

    expect(defaultEquals(p1, p2)).toBe(true);
    expect(defaultEquals(p1, p3)).toBe(false);
    expect(defaultHash(p1)).toBe(defaultHash(p2));
    expect(defaultHash(p1)).not.toBe(defaultHash(p3));
  });

  test("falls back to ref-equality / identity hash for plain objects", () => {
    const a = new IdentityOnly(1);
    const b = new IdentityOnly(1);
    expect(defaultEquals(a, b)).toBe(false);
    expect(defaultEquals(a, a)).toBe(true);
    expect(defaultHash(a)).not.toBe(defaultHash(b));
  });

  test("HashSet de-dupes structurally-equal user objects", () => {
    const s = HashSet.empty<Pair>().add(new Pair(1, 2)).add(new Pair(1, 2));
    expect(s.count).toBe(1);
    expect(s.contains(new Pair(1, 2))).toBe(true);
    expect(s.contains(new Pair(2, 1))).toBe(false);
  });

  test("HashMap looks up structurally-equal user keys", () => {
    let m = HashMap.empty<Pair, string>();
    m = m.add(new Pair(1, 2), "x");
    expect(m.tryFind(new Pair(1, 2))).toBe("x");
    expect(m.containsKey(new Pair(1, 2))).toBe(true);
    expect(m.tryFind(new Pair(2, 1))).toBe(undefined);
  });

  test("primitives and null/undefined", () => {
    expect(defaultEquals(1, 1)).toBe(true);
    expect(defaultEquals("a", "a")).toBe(true);
    expect(defaultEquals(null, null)).toBe(true);
    expect(defaultEquals(undefined, undefined)).toBe(true);
    expect(defaultEquals(null, undefined)).toBe(false);
    expect(defaultHash("a")).toBe(defaultHash("a"));
  });
});
