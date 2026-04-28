// Port of FSharp.Data.Adaptive.Tests/Transaction.fs

import { describe, expect, test } from "vitest";
import {
  getCurrentBuiltTransaction,
  transact,
} from "../src/core/transaction.js";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";

describe("[Transaction]", () => {
  test("transact sets/restores current", () => {
    transact(() => {
      const a = getCurrentBuiltTransaction();
      transact(() => {
        const b = getCurrentBuiltTransaction();
        expect(a).not.toBe(b);
      });
      expect(getCurrentBuiltTransaction()).toBe(a);
    });
    expect(getCurrentBuiltTransaction()).toBeNull();
  });

  test("transact sets/restores current on exception", () => {
    transact(() => {
      const a = getCurrentBuiltTransaction();
      try {
        transact(() => {
          throw new Error("inner exn");
        });
      } catch {
        // expected
      }
      expect(getCurrentBuiltTransaction()).toBe(a);
    });
  });

  test("[AVal] callbacks", () => {
    const f = cval(true);
    const a = cval(10);
    const b = cval(5);

    const aMapped = AVal.map(
      (x: number) => x,
      AVal.map((x: number) => x, AVal.map((x: number) => x, a)),
    );
    const result = AVal.bind(
      (flag: boolean) => (flag ? b : aMapped),
      f,
    );

    let wasrun = false;
    let expected = 5;
    const sub = result.addCallback((v: number) => {
      wasrun = true;
      expect(v).toBe(expected);
    });

    try {
      expect(wasrun).toBe(true);
      wasrun = false;

      const change = (action: () => number | null) => {
        const shouldRun = transact(() => {
          wasrun = false;
          const e = action();
          if (e !== null) {
            expected = e;
            return true;
          }
          return false;
        });
        expect(wasrun).toBe(shouldRun);
        wasrun = false;
      };

      change(() => {
        f.value = false;
        return 10;
      });
      change(() => {
        a.value = 7;
        return 7;
      });
      change(() => {
        b.value = 123;
        return null;
      });
      change(() => {
        f.value = true;
        return 123;
      });
    } finally {
      sub.dispose();
    }

    // After dispose, a change to b should not fire the callback.
    transact(() => {
      b.value = 321;
    });
  });

  test("[CVal] no transaction change", () => {
    const c = cval(5);
    c.value = 1;
    AVal.force(c);
    c.value = 2;
    // The test passes if no exception was thrown — outside a
    // transaction, mutating a cval whose Outputs is empty should be
    // allowed (it just sets the value and marks). With Outputs
    // populated (after a force-with-caller), it would fail. AVal.force
    // uses the Top token which has no caller, so Outputs stays empty.
    expect(AVal.force(c)).toBe(2);
  });

  // Deferred to later phases (still depend on aset/clist):
  test.todo("[CSet] no transaction add (deferred to phase 4)");
  test.todo("[CSet] no transaction remove (deferred to phase 4)");
  test.todo("[CList] no transaction append (deferred to phase 6)");
  test.todo("[CList] no transaction remove (deferred to phase 6)");
});
