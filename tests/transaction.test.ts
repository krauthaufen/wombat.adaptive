// Port of FSharp.Data.Adaptive.Tests/Transaction.fs
//
// PORT NOTE: the F# test file mixes pure-transaction tests with tests
// that exercise cval/cset/clist/AVal callbacks. Phase 1 only ports the
// pure-transaction subset; the rest are deferred to later phases as
// noted below.

import { describe, expect, test } from "vitest";
import {
  getCurrentBuiltTransaction,
  transact,
} from "../src/core/transaction.js";

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

  // PORT NOTE: the following tests from the F# original depend on AVal,
  // cset, clist, callbacks — features added in later phases. Skipping
  // here; they are reintroduced when their dependencies land.
  //
  //   [AVal] callbacks                  — phase 2 (AVal.map/bind/callbacks)
  //   [CSet] no transaction add/remove  — phase 4 (cset)
  //   [CList] no transaction append/remove — phase 6 (clist)
  //   [CVal] no transaction change      — phase 2 (cval)
  test.todo("[AVal] callbacks (deferred to phase 2)");
  test.todo("[CSet] no transaction add (deferred to phase 4)");
  test.todo("[CSet] no transaction remove (deferred to phase 4)");
  test.todo("[CList] no transaction append (deferred to phase 6)");
  test.todo("[CList] no transaction remove (deferred to phase 6)");
  test.todo("[CVal] no transaction change (deferred to phase 2)");
});
