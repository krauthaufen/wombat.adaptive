// Port of FSharp.Data.Adaptive.Tests/Transaction.fs

import { describe, expect, test } from "vitest";
import {
  getCurrentBuiltTransaction,
  transact,
} from "../src/core/transaction.js";
import {
  AVal,
  cval,
  type aval,
} from "../src/adaptiveValue/adaptiveValue.js";

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

    const aMapped = a.map((x) => x).map((x) => x).map((x) => x);
    const result = f.bind((flag): aval<number> => (flag ? b : aMapped));

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
    c.force();
    c.value = 2;
    expect(c.force()).toBe(2);
  });

  // Deferred to later phases (still depend on aset/clist):
  test.todo("[CSet] no transaction add (deferred to phase 4)");
  test.todo("[CSet] no transaction remove (deferred to phase 4)");
  test.todo("[CList] no transaction append (deferred to phase 6)");
  test.todo("[CList] no transaction remove (deferred to phase 6)");
});
