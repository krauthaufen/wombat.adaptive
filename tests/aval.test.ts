// Port of FSharp.Data.Adaptive.Tests/AVal.fs
//
// PORT NOTE: F# `should equal` for adaptive values relies on overridden
// .Equals/GetHashCode in ConstantVal/MapNonAdaptiveVal that compare by
// structural content (value or mapping+input). TS has no structural
// equality — we expose `equals` methods on the relevant types and use
// them explicitly in tests where the original used `should equal`.
//
// PORT NOTE: tests using FsCheck reference-impl property generators
// (`[AVal] reference impl`) are deferred. They require porting the
// `Generators` infrastructure (alongside a reference implementation),
// which is its own subproject.
//
// PORT NOTE: `[AVal] ChangeableLazyVal working` depends on
// `AdaptifyHelpers.ChangeableLazyVal`, part of the Adaptify track and
// not in phase 2.

import { describe, expect, test } from "vitest";
import {
  AVal,
  ChangeableValue,
  cval,
  constantEquals,
  type aval,
} from "../src/adaptiveValue/adaptiveValue.js";
import { AdaptiveObject } from "../src/core/adaptiveObject.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { transact } from "../src/core/transaction.js";
import type { IAdaptiveValue, IAdaptiveValueVisitor } from "../src/adaptiveValue/adaptiveValue.js";

describe("[AVal]", () => {
  test("constant equality", () => {
    // Constant of the same primitive value compares equal.
    const a1 = AVal.constant(42 as unknown);
    const b1 = AVal.constant(42 as unknown);
    expect(constantEquals(a1, b1)).toBe(true);

    // Constant of `null` compares equal.
    const a2 = AVal.constant(null);
    const b2 = AVal.constant(null);
    expect(constantEquals(a2, b2)).toBe(true);

    // PORT NOTE: F# tests `AVal.constant { value = 42 }` and expects
    // structural equality through F# record value semantics. JS records
    // (objects) are reference-equal only, so we only assert primitives
    // here. This is a deliberate divergence (see file header).
    const x = { value: 1 };
    const y = { value: 2 };
    const ax = AVal.constant(x);
    const ay = AVal.constant(y);
    expect(constantEquals(ax, ay)).toBe(false);
  });

  test("map constant", () => {
    const a = AVal.constant(1);
    const b = a.map((x) => x);
    expect(b.isConstant).toBe(true);
  });

  test("map2 constant (via zip)", () => {
    const a = AVal.constant(1);
    const b = AVal.constant(2);
    const t = AVal.zip(a, b).map((x, y) => [x, y] as const);
    expect(t.isConstant).toBe(true);
  });

  test("map3 constant (via zip)", () => {
    const a = AVal.constant(1);
    const b = AVal.constant(2);
    const c = AVal.constant(3);
    const t = AVal.zip(a, b, c).map((x, y, z) => [x, y, z] as const);
    expect(t.isConstant).toBe(true);
  });

  test("bind content", () => {
    // bind from a *constant* input should return the inner aval directly.
    const a = AVal.constant(10);
    const b = AVal.init("b").map((x) => x);
    const c = AVal.init("c").map((x) => x);

    const t = a.bind((va) => (va === 10 ? b : c));
    expect(t).toBe(b);
  });

  test("nop change evaluation", () => {
    const input = AVal.init(5);
    const a = input.map((x) => x);
    const b = input.map((x) => -x);
    const c = AVal.zip(a, b).map((x, y) => x + y);
    let mapCounter = 0;
    const d = c.map((v) => {
      mapCounter += 1;
      return v;
    });

    expect(d.force()).toBe(0);
    expect(mapCounter).toBe(1);
    mapCounter = 0;

    transact(() => {
      input.value = 10;
    });
    expect(d.outOfDate).toBe(true);
    expect(d.force()).toBe(0);
    // d's mapping must NOT have run because c's value didn't change
    // (5 + -5 == 10 + -10 == 0). Cache short-circuit in MapVal.
    expect(mapCounter).toBe(0);
  });

  test("map non-adaptive and bind", () => {
    const v = AVal.init(true);
    const a = AVal.constant(0);
    const b = AVal.constant(1);
    const out = v
      .map((x) => x)
      .mapNonAdaptive((x) => x)
      .bind((flag) => (flag ? a : b));
    expect(out.force()).toBe(0);
    transact(() => {
      v.value = false;
    });
    expect(out.force()).toBe(1);
  });

  test("multi map non-adaptive and bind", () => {
    const v = AVal.init(true);
    const a = AVal.constant(0);
    const b = AVal.constant(1);
    const out = v
      .map((x) => x)
      .mapNonAdaptive((x) => x)
      .mapNonAdaptive((x) => x)
      .bind((flag) => (flag ? a : b));
    expect(out.force()).toBe(0);
    transact(() => {
      v.value = false;
    });
    expect(out.force()).toBe(1);
  });

  // -------------------------------------------------------------------
  // EagerVal-based tests (port of F# EagerVal subclass)
  // -------------------------------------------------------------------

  class EagerVal<T> extends AdaptiveObject implements aval<T> {
    private readonly _input: aval<T>;
    private _last: { v: T } | undefined = undefined;

    constructor(input: aval<T>) {
      super();
      this._input = input;
    }

    override mark(): boolean {
      const v = this._input.getValue(new AdaptiveToken(this));
      if (this._last !== undefined && Object.is(this._last.v, v)) {
        return false;
      }
      return true;
    }

    getValue(token: AdaptiveToken): T {
      return this.evaluateAlways(token, (tok) => {
        const res = this._input.getValue(tok);
        this._last = { v: res };
        return res;
      });
    }

    accept<R>(visitor: IAdaptiveValueVisitor<R>): R {
      return visitor.visit(this);
    }
    getValueUntyped(t: AdaptiveToken): unknown {
      return this.getValue(t);
    }
    map<R>(f: (a: T) => R): aval<R> {
      return AVal.map(this, f);
    }
    bind<R>(f: (a: T) => aval<R>): aval<R> {
      return AVal.bind(this, f);
    }
    mapNonAdaptive<R>(f: (a: T) => R): aval<R> {
      return AVal.mapNonAdaptive(this, f);
    }
    force(): T {
      return AVal.force(this);
    }
    addCallback(action: (v: T) => void) {
      return AVal.addCallback(this, action);
    }
    addWeakCallback(action: (v: T) => void) {
      return AVal.addWeakCallback(this, action);
    }
  }

  test("eager evaluation", () => {
    const a = AVal.init(0);
    const short = AVal.init("a");
    const long_ = AVal.init("a").map((x) => x).map((x) => x).map((x) => x);
    const different = AVal.init("b")
      .map((x) => x)
      .map((x) => x)
      .map((x) => x)
      .map((x) => x)
      .map((x) => x);

    const dynamic = a.bind((l) => {
      if (l === 0) return short as aval<string>;
      if (l === 1) return long_;
      return different;
    });

    const eager = new EagerVal<string>(dynamic) as aval<string>;
    expect(eager.force()).toBe("a");
    expect((eager as AdaptiveObject).level).toBe(2);

    // makes eager level larger (LevelChangedException) but does not
    // change content.
    transact(() => {
      a.value = 1;
    });
    expect((eager as AdaptiveObject).outOfDate).toBe(false);
    expect(eager.force()).toBe("a");
    expect((eager as AdaptiveObject).level).toBeGreaterThan(
      (long_ as unknown as AdaptiveObject).level,
    );

    // actually changes content.
    transact(() => {
      a.value = 2;
    });
    expect((eager as AdaptiveObject).outOfDate).toBe(true);
    expect(eager.force()).toBe("b");
    expect((eager as AdaptiveObject).level).toBeGreaterThan(
      (different as unknown as AdaptiveObject).level,
    );
  });

  test("eager marking", () => {
    const a = AVal.init(0);
    const mod2 = a.map((v) => v % 2);
    const eager = new EagerVal<number>(mod2) as aval<number>;
    const out = eager.map((x) => x);

    expect(out.force()).toBe(0);

    transact(() => {
      a.value = 2;
    });
    expect((out as unknown as AdaptiveObject).outOfDate).toBe(false);
    expect(out.force()).toBe(0);

    transact(() => {
      a.value = 1;
    });
    expect((out as unknown as AdaptiveObject).outOfDate).toBe(true);
    expect(out.force()).toBe(1);

    transact(() => {
      a.value = 3;
    });
    expect((out as unknown as AdaptiveObject).outOfDate).toBe(false);
    expect(out.force()).toBe(1);

    transact(() => {
      a.value = 0;
    });
    expect((out as unknown as AdaptiveObject).outOfDate).toBe(true);
    expect(out.force()).toBe(0);
  });

  // -------------------------------------------------------------------
  // GC-dependent tests
  // -------------------------------------------------------------------

  const gc = (globalThis as { gc?: () => void }).gc;
  const maybe = typeof gc === "function" ? test : test.skip;
  maybe("mapNonAdaptive GC correct", async () => {
    const v = cval(10);
    const test = v.mapNonAdaptive((x) => x + 1).map((x) => x);
    expect(test.force()).toBe(11);

    for (let i = 0; i < 5; i++) {
      gc!();
      await new Promise((r) => setTimeout(r, 0));
    }

    transact(() => {
      v.value = 100;
    });
    expect(test.force()).toBe(101);
  });

  // -------------------------------------------------------------------
  // n-ary via zip — these have no F# counterpart (F# uses map2/map3),
  // they're added to validate the TS variadic inference.
  // -------------------------------------------------------------------

  test("zip(2).map infers and computes correctly", () => {
    const x = AVal.init(2);
    const y = AVal.init(3);
    const z = AVal.zip(x, y).map((a, b) => a * b);
    // a: number, b: number inferred from x/y
    expect(z.force()).toBe(6);
    transact(() => {
      x.value = 10;
    });
    expect(z.force()).toBe(30);
  });

  test("zip(3).map infers and computes correctly", () => {
    const x = AVal.init(1);
    const y = AVal.init("x");
    const z = AVal.init(true);
    const r = AVal.zip(x, y, z).map((a, b, c) => `${a}-${b}-${c}`);
    // a: number, b: string, c: boolean
    expect(r.force()).toBe("1-x-true");
    transact(() => {
      y.value = "yy";
      z.value = false;
    });
    expect(r.force()).toBe("1-yy-false");
  });

  test("zip(4).map dispatches to MapNVal and recomputes", () => {
    const a = AVal.init(1);
    const b = AVal.init(2);
    const c = AVal.init(3);
    const d = AVal.init(4);
    const sum = AVal.zip(a, b, c, d).map((x, y, z, w) => x + y + z + w);
    expect(sum.force()).toBe(10);
    transact(() => {
      a.value = 10;
      d.value = 40;
    });
    expect(sum.force()).toBe(55);
  });

  test("zip(2).bind switches inner aval", () => {
    const flag = AVal.init(true);
    const a = AVal.init(1);
    const b = AVal.init(2);
    const r = AVal.zip(flag, a).bind((f, av) => (f ? a : b).map((x) => x + av));
    expect(r.force()).toBe(2);
    transact(() => {
      flag.value = false;
    });
    expect(r.force()).toBe(3);
  });

  // -------------------------------------------------------------------
  // Deferred tests (require infrastructure not yet ported)
  // -------------------------------------------------------------------

  test.todo("[AVal] reference impl (FsCheck reference-impl generators)");
  test.todo(
    "[AVal] cast equality (requires structural equality on MapNonAdaptiveVal)",
  );
  test.todo(
    "[AVal] ChangeableLazyVal working (depends on AdaptifyHelpers in parallel track)",
  );
});
