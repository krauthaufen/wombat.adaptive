// Standalone tests for `MemoTrie` — the generic weak-keyed cache trie
// underlying the internal memoization layer (`src/internal/memo.ts`).

import { describe, expect, test } from "vitest";
import { MemoTrie, memoize } from "../../src/core/memoTrie.js";

describe("MemoTrie", () => {
  test("empty lookup returns undefined", () => {
    const t = new MemoTrie();
    expect(t.lookup([{}, {}])).toBeUndefined();
  });

  test("insert then lookup returns the same value", () => {
    const t = new MemoTrie();
    const k1 = {};
    const k2 = {};
    const v = { id: "v" };
    t.insert([k1, k2], v);
    expect(t.lookup([k1, k2])).toBe(v);
  });

  test("different paths do not collide", () => {
    const t = new MemoTrie();
    const a = {};
    const b = {};
    const c = {};
    const v1 = { id: 1 };
    const v2 = { id: 2 };
    t.insert([a, b], v1);
    t.insert([a, c], v2);
    expect(t.lookup([a, b])).toBe(v1);
    expect(t.lookup([a, c])).toBe(v2);
  });

  test("multi-level paths", () => {
    const t = new MemoTrie();
    const keys = [{}, {}, {}, {}];
    const v = { tag: "deep" };
    t.insert(keys, v);
    expect(t.lookup(keys)).toBe(v);
    // Prefix-only lookup is a miss (leaf is at the full depth).
    expect(t.lookup(keys.slice(0, 2))).toBeUndefined();
  });

  test("partial path with no entry returns undefined", () => {
    const t = new MemoTrie();
    const a = {};
    const b = {};
    const c = {};
    t.insert([a, b], { id: "ab" });
    expect(t.lookup([a, c])).toBeUndefined();
  });

  test("memoize helper computes once and caches", () => {
    const t = new MemoTrie();
    const a = {};
    let calls = 0;
    const compute = () => {
      calls++;
      return { id: calls };
    };
    const v1 = memoize(t, [a], compute);
    const v2 = memoize(t, [a], compute);
    expect(v1).toBe(v2);
    expect(calls).toBe(1);
  });
});
