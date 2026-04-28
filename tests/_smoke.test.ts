// Internal smoke test: hand-rolled minimal `cval` and `aval.map` exercising
// the entire phase-1 protocol end-to-end. Not a port of any F# test — this
// is the proof that the core machinery survived translation.

import { describe, expect, test } from "vitest";
import { AdaptiveObject } from "../src/core/adaptiveObject.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import {
  hasRunningTransaction,
  markOutdated,
  transact,
} from "../src/core/transaction.js";

/// Minimal cval-like writable cell.
class MyCVal<T> extends AdaptiveObject {
  private _value: T;
  constructor(initial: T) {
    super();
    this._value = initial;
    this.outOfDate = false;
  }
  get value(): T {
    return this._value;
  }
  set value(v: T) {
    transact(() => {
      this._value = v;
      markOutdated(this);
    });
  }
  /// Read inside an evaluation context.
  getValue(token: AdaptiveToken): T {
    return this.evaluateAlways(token, () => this._value);
  }
  /// Top-level read (no caller).
  force(): T {
    return this.getValue(AdaptiveToken.top);
  }
}

/// Minimal aval.map-like derived cell.
class MyMappedAVal<A, B> extends AdaptiveObject {
  private readonly _input: MyCVal<A>;
  private readonly _f: (a: A) => B;
  private _cache: B | undefined;
  constructor(input: MyCVal<A>, f: (a: A) => B) {
    super();
    this._input = input;
    this._f = f;
  }
  getValue(token: AdaptiveToken): B {
    return this.evaluateAlways(token, (tok) => {
      if (this.outOfDate || this._cache === undefined) {
        this._cache = this._f(this._input.getValue(tok));
      }
      return this._cache;
    });
  }
  force(): B {
    return this.getValue(AdaptiveToken.top);
  }
}

describe("smoke: cval + map end-to-end", () => {
  test("read pulls value through the chain", () => {
    const c = new MyCVal(1);
    const m = new MyMappedAVal(c, (x: number) => x * 2);
    expect(m.force()).toBe(2);
  });

  test("mutation propagates and is visible after transaction commits", () => {
    const c = new MyCVal(1);
    const m = new MyMappedAVal(c, (x: number) => x * 2);
    expect(m.force()).toBe(2);

    c.value = 5;
    expect(m.force()).toBe(10);
  });

  test("outOfDate flips correctly across the chain", () => {
    const c = new MyCVal(1);
    const m = new MyMappedAVal(c, (x: number) => x * 2);

    expect(m.force()).toBe(2);
    expect(m.outOfDate).toBe(false);
    expect(c.outOfDate).toBe(false);

    transact(() => {
      c.value = 5;
    });
    // After commit, m must have been marked outOfDate (via the Outputs
    // edge from c → m established during the read).
    expect(m.outOfDate).toBe(true);

    expect(m.force()).toBe(10);
    expect(m.outOfDate).toBe(false);
  });

  test("output edge is wired up after first read", () => {
    const c = new MyCVal(1);
    const m = new MyMappedAVal(c, (x: number) => x * 2);

    expect(c.outputs.isEmpty).toBe(true);
    m.force();
    expect(c.outputs.isEmpty).toBe(false);
  });

  test("level escalates through the chain", () => {
    const c = new MyCVal(1);
    const m1 = new MyMappedAVal(c, (x: number) => x + 1);
    const m2 = new MyMappedAVal<number, number>(
      m1 as unknown as MyCVal<number>,
      (x: number) => x * 10,
    );
    // m2 reads m1 reads c — levels: c=0, m1>=1, m2>=2 after read.
    expect(m2.force()).toBe(20);
    expect(m1.level).toBeGreaterThanOrEqual(1);
    expect(m2.level).toBeGreaterThanOrEqual(2);
  });

  test("hasRunningTransaction is false outside transact", () => {
    expect(hasRunningTransaction()).toBe(false);
  });

  test("hasRunningTransaction is true inside commit", () => {
    const c = new MyCVal(1);
    let observedDuringMark = false;
    class HookedMapped extends MyMappedAVal<number, number> {
      override mark(): boolean {
        if (hasRunningTransaction()) observedDuringMark = true;
        return super.mark();
      }
    }
    const m = new HookedMapped(c, (x) => x);
    m.force(); // wires the edge
    transact(() => {
      c.value = 2;
    });
    expect(observedDuringMark).toBe(true);
  });
});
