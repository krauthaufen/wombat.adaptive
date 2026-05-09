// Behavioural tests for the adaptive-memo Vite plugin.
//
// These tests are compiled with the plugin actively applied (see
// `vitest.transformed.config.ts`). The source you read here is plain
// adaptive code; what vitest actually compiles is the rewritten form
// where each `.map(f)` / `.bind(f)` / etc. has been wrapped in a
// `__memo([...keys], () => ...)` call. We assert that the rewrite
// achieves both (1) reference-equal sharing across structurally
// identical call sites and (2) semantic correctness — derived avals
// produce the right values and propagate marks.
//
// If the plugin's emitted code is broken, these tests fail naturally.

import { describe, expect, test } from "vitest";
import { transact } from "@aardworx/wombat.adaptive";
import { cval, force } from "@aardworx/wombat.adaptive/aval";
import { double, isPositive, negate } from "./fixtures.js";

describe("[plugin/behavioural] aval.map memoization", () => {
  test("module-level identifier callback: same source + same fn → same derived", () => {
    const av = cval(1);
    const m1 = av.map(double);
    const m2 = av.map(double);
    expect(m1).toBe(m2);
  });

  test("different source, same identifier callback → different derived", () => {
    const av1 = cval(1);
    const av2 = cval(1);
    const m1 = av1.map(double);
    const m2 = av2.map(double);
    expect(m1).not.toBe(m2);
  });

  test("same source, different identifier callback → different derived", () => {
    const av = cval(1);
    const m1 = av.map(double);
    const m2 = av.map(negate);
    expect(m1).not.toBe(m2);
  });

  test("inline lambda with same body shape → same derived (body-hash)", () => {
    // Two distinct arrow allocations that the plugin's body-hash
    // collapses to one cache key. Without the plugin these would be
    // two distinct derived avals.
    const av = cval(1);
    const m1 = av.map((t) => t * 2);
    const m2 = av.map((t) => t * 2);
    expect(m1).toBe(m2);
  });

  test("inline lambda with different body → different derived", () => {
    const av = cval(1);
    const m1 = av.map((t) => t * 2);
    const m2 = av.map((t) => t * 3);
    expect(m1).not.toBe(m2);
  });

  test("inline lambda whitespace-only body difference → same derived", () => {
    // The plugin hashes the AST-printed shape, so trivial whitespace
    // does not change the hash.
    const av = cval(1);
    const m1 = av.map((t) => t * 2);
    const m2 = av.map((t) => t * 2 /* same */);
    expect(m1).toBe(m2);
  });
});

describe("[plugin/behavioural] aval.map closure-deps", () => {
  test("captured local: different captured values → different derived", () => {
    function build(scale: number) {
      const av = cval(1);
      return [av, av.map((t) => t * scale)] as const;
    }
    const [, m1] = build(2);
    const [, m2] = build(3);
    expect(m1).not.toBe(m2);
  });

  test("captured local: same captured value + same source → same derived", () => {
    const av = cval(1);
    function withScale(scale: number) {
      return av.map((t) => t * scale);
    }
    const m1 = withScale(5);
    const m2 = withScale(5);
    expect(m1).toBe(m2);
  });

  test("captured local: same value but different source → different derived", () => {
    function pair() {
      const a = cval(1);
      const b = cval(1);
      const k = 7;
      return [a.map((t) => t * k), b.map((t) => t * k)] as const;
    }
    const [m1, m2] = pair();
    expect(m1).not.toBe(m2);
  });

  test("multiple captured locals", () => {
    const av = cval(1);
    function build(scale: number, offset: number) {
      return av.map((t) => t * scale + offset);
    }
    const a = build(2, 10);
    const b = build(2, 10);
    const c = build(3, 10);
    const d = build(2, 11);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  test("member-access dep: capturing a.b uses 'a' as dep base", () => {
    // Plugin emits the base identifier as the dep (conservative —
    // re-binding `params` will invalidate even if the relevant field
    // didn't change). Behavioural check: same params object → same
    // derived; different params object → different derived.
    const av = cval(1);
    function build(params: { scale: number }) {
      return av.map((t) => t * params.scale);
    }
    const p = { scale: 4 };
    const m1 = build(p);
    const m2 = build(p);
    expect(m1).toBe(m2);

    const m3 = build({ scale: 4 });
    expect(m1).not.toBe(m3);
  });
});

describe("[plugin/behavioural] correctness", () => {
  test("derived produces the right value", () => {
    const av = cval(7);
    const m = av.map(double);
    expect(force(m)).toBe(14);
  });

  test("source mark propagates to derived", () => {
    const av = cval(7);
    const m = av.map(double);
    expect(force(m)).toBe(14);
    transact(() => {
      av.value = 10;
    });
    expect(force(m)).toBe(20);
  });

  test("inline-lambda derived produces correct value and updates", () => {
    const av = cval(3);
    const m = av.map((t) => t * t);
    expect(force(m)).toBe(9);
    transact(() => {
      av.value = 5;
    });
    expect(force(m)).toBe(25);
  });

  test("aval.bind: derived dispatches and propagates", () => {
    const sw = cval(true);
    const a = cval(1);
    const b = cval(100);
    const m = sw.bind((flag) => (flag ? a : b));
    expect(force(m)).toBe(1);
    transact(() => {
      sw.value = false;
    });
    expect(force(m)).toBe(100);
    transact(() => {
      b.value = 200;
    });
    expect(force(m)).toBe(200);
  });

  test("aval.bind: same shape memoises", () => {
    const sw = cval(true);
    const a = cval(1);
    const b = cval(2);
    const m1 = sw.bind((flag) => (flag ? a : b));
    const m2 = sw.bind((flag) => (flag ? a : b));
    expect(m1).toBe(m2);
  });

  test("predicate via identifier", () => {
    const av = cval(-3);
    const m = av.map(isPositive);
    expect(force(m)).toBe(false);
    transact(() => {
      av.value = 5;
    });
    expect(force(m)).toBe(true);
  });
});
