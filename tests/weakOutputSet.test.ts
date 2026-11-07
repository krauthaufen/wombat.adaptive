// Port of FSharp.Data.Adaptive.Tests/WeakOutputSet.fs

import { describe, expect, test, vi } from "vitest";
import { WeakOutputSet } from "../src/core/weakOutputSet.js";
import type { IAdaptiveObject, IWeakOutputSet, OutputBuffer } from "../src/core/types.js";

// PORT NOTE: the F# test uses `NonEqualObject` extending AdaptiveObject and
// overriding GetHashCode/Equals to fail, ensuring WeakOutputSet uses only
// reference identity. JS object identity (===) is reference identity by
// default, so we don't need to override anything — but we do need a minimal
// IAdaptiveObject stub to avoid depending on AdaptiveObject from this test.
class StubObject implements IAdaptiveObject {
  tag: unknown = null;
  level = 0;
  outOfDate = true;
  readonly outputs: IWeakOutputSet = new WeakOutputSet();
  readonly isConstant = false;
  private _weak: WeakRef<IAdaptiveObject> | null = null;
  get weak(): WeakRef<IAdaptiveObject> {
    if (this._weak === null) this._weak = new WeakRef<IAdaptiveObject>(this);
    return this._weak;
  }
  mark(): boolean {
    return true;
  }
  inputChanged(_t: unknown, _o: IAdaptiveObject): void {}
  allInputsProcessed(_t: unknown): void {}
}

const relevantSizes = [0, 1, 2, 4, 8, 9, 20];

describe("[WeakOutputSet]", () => {
  test("add", () => {
    for (const cnt of relevantSizes) {
      const set = new WeakOutputSet();
      const many = Array.from({ length: cnt }, () => new StubObject());
      for (const m of many) {
        expect(set.add(m)).toBe(true);
      }

      const arr: OutputBuffer = { value: new Array(8).fill(undefined) };
      const got = set.consume(arr);
      expect(got).toBe(many.length);
      for (let i = 0; i < got; i++) {
        const a = arr.value[i];
        expect(many.some((m) => m === a)).toBe(true);
      }
    }
  });

  test("remove", () => {
    for (const cnt of relevantSizes) {
      const set = new WeakOutputSet();
      const many = Array.from({ length: cnt }, () => new StubObject());
      for (const m of many) expect(set.add(m)).toBe(true);
      for (const m of many) expect(set.remove(m)).toBe(true);

      const arr: OutputBuffer = { value: new Array(8).fill(undefined) };
      const got = set.consume(arr);
      expect(got).toBe(0);
    }
  });

  // PORT NOTE: these tests force GC, which needs Node's `--expose-gc`
  // (set in vitest.config.ts); they skip themselves without it.
  const gc = (globalThis as { gc?: () => void }).gc;
  const maybe = typeof gc === "function" ? test : test.skip;
  maybe("actually weak", async () => {
    for (const cnt of relevantSizes) {
      const set = new WeakOutputSet();
      const addDead = (): void => {
        const many = Array.from({ length: cnt }, () => new StubObject());
        for (const m of many) {
          expect(set.add(m)).toBe(true);
        }
      };

      addDead();
      // Encourage finalizable WeakRefs to clear: run gc multiple times,
      // letting the microtask queue drain in between so any pending
      // finalization can settle.
      for (let i = 0; i < 5; i++) {
        gc!();
        await new Promise((r) => setTimeout(r, 0));
      }

      const arr: OutputBuffer = { value: new Array(8).fill(undefined) };
      const got = set.consume(arr);
      // PORT NOTE: a single output is held strongly (no WeakRef per
      // node, as in the F# Fable variant); it lives until the next
      // consume or remove. Two or more outputs are weak.
      expect(got).toBe(cnt === 1 ? 1 : 0);
    }
  });

  maybe("a strongly held single output becomes weak once a second one is added", async () => {
    const set = new WeakOutputSet();
    const live = new StubObject();
    (() => { set.add(new StubObject()); })();
    set.add(live);
    for (let i = 0; i < 5; i++) {
      gc!();
      await new Promise((r) => setTimeout(r, 0));
    }
    const arr: OutputBuffer = { value: [] };
    expect(set.consume(arr)).toBe(1);
    expect(arr.value[0]).toBe(live);
  });
});

describe("WeakOutputSet set-mode sweep", () => {
  test("filling a set with n outputs is linear (sweeps amortised)", () => {
    const n = 20000;
    const objs = Array.from({ length: n }, () => new StubObject());
    for (const o of objs) void o.weak;
    const set = new WeakOutputSet();
    const deref = vi.spyOn(WeakRef.prototype, "deref");
    try {
      const t0 = performance.now();
      for (const o of objs) set.add(o);
      const ms = performance.now() - t0;
      // a sweep every 100 adds dereferenced the whole set: ~n²/200 = 2e6
      expect(deref.mock.calls.length).toBeLessThan(10 * n);
      console.log(`[bench] ${n} outputs added in ${ms.toFixed(1)} ms, ${deref.mock.calls.length} derefs`);
    } finally {
      deref.mockRestore();
    }
    const buf: OutputBuffer = { value: [] };
    expect(set.consume(buf)).toBe(n);
  });
});

describe("WeakOutputSet single output", () => {
  test("the first output is held without allocating its WeakRef", () => {
    const a = new StubObject();
    const set = new WeakOutputSet();
    const weak = vi.spyOn(a, "weak", "get");
    expect(set.add(a)).toBe(true);
    expect(set.add(a)).toBe(false);
    expect(weak).not.toHaveBeenCalled();
    const buf: OutputBuffer = { value: [] };
    expect(set.consume(buf)).toBe(1);
    expect(buf.value[0]).toBe(a);
    expect(set.isEmpty).toBe(true);
  });

  test("a second output moves both to weak storage, removing one goes back to single", () => {
    const a = new StubObject(), b = new StubObject();
    const set = new WeakOutputSet();
    set.add(a); set.add(b);
    expect(set.remove(a)).toBe(true);
    expect(set.add(b)).toBe(false);
    const buf: OutputBuffer = { value: [] };
    expect(set.consume(buf)).toBe(1);
    expect(buf.value[0]).toBe(b);
  });
});
