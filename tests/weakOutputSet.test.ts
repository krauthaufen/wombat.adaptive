// Port of FSharp.Data.Adaptive.Tests/WeakOutputSet.fs

import { describe, expect, test } from "vitest";
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

  // PORT NOTE: this test requires forcing GC, which requires Node's
  // `--expose-gc` flag. Run via:
  //   NODE_OPTIONS=--expose-gc npm test
  // The test skips itself otherwise so the rest of the suite stays green.
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
      expect(got).toBe(0);
    }
  });
});
