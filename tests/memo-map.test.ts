// Tests for `memoAvalMap` — opt-in dedup of derived avals by
// `(source, f)` reference identity. Migrated from the old
// public-API `aval.memoMap` to the new internal API in
// `src/internal/memo.ts`.

import { describe, expect, test } from "vitest";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";
import { memoAvalMap } from "../src/internal/memo.js";
import { transact } from "../src/core/transaction.js";

describe("[internal] memoAvalMap", () => {
  test("hit: same source + same fn returns same derived aval", () => {
    const av = cval(1);
    const f = (x: number) => x + 1;
    const m1 = memoAvalMap(av, f);
    const m2 = memoAvalMap(av, f);
    expect(m1).toBe(m2);
  });

  test("miss: different source aval", () => {
    const av1 = cval(1);
    const av2 = cval(1);
    const f = (x: number) => x + 1;
    const m1 = memoAvalMap(av1, f);
    const m2 = memoAvalMap(av2, f);
    expect(m1).not.toBe(m2);
  });

  test("miss: different fn references", () => {
    const av = cval(1);
    const f1 = (x: number) => x + 1;
    const f2 = (x: number) => x + 1; // structurally equal, distinct refs
    const m1 = memoAvalMap(av, f1);
    const m2 = memoAvalMap(av, f2);
    expect(m1).not.toBe(m2);
  });

  test("behavioural: getValue equals f(source)", () => {
    const av = cval(7);
    const f = (x: number) => x * 3;
    const m = memoAvalMap(av, f);
    expect(AVal.force(m)).toBe(21);
  });

  test("reactive propagation through memoized derivation", () => {
    const av = cval(2);
    const f = (x: number) => x * 10;
    const m = memoAvalMap(av, f);
    expect(AVal.force(m)).toBe(20);
    transact(() => {
      av.value = 5;
    });
    expect(AVal.force(m)).toBe(50);
  });

  test("structural integrity: callable when source is held only weakly", () => {
    // We don't try to *force* GC — just assert the WeakMap path
    // tolerates being asked about an aval that is itself held in a
    // WeakRef in user code. The cache shouldn't crash on insert/lookup.
    const av = cval(1);
    const ref = new WeakRef(av);
    const f = (x: number) => x + 1;
    const m1 = memoAvalMap(av, f);
    const live = ref.deref();
    expect(live).toBe(av);
    const m2 = memoAvalMap(live as typeof av, f);
    expect(m2).toBe(m1);
  });
});
