// Port of FSharp.Data.Adaptive.Tests/Callbacks.fs
//
// PORT NOTE: F# `Interlocked.Increment`/`Interlocked.Exchange` for the
// `fired` counter — JS single-threaded, plain mutation suffices.
//
// PORT NOTE: `[AddCallback] surviving GC` and `[AddWeakCallback] not
// surviving GC` exercise `aset.AddCallback`/`AddWeakCallback`. ASet is a
// phase 4 feature — these tests are deferred.

import { describe, expect, test } from "vitest";
import { cval } from "../src/adaptiveValue/adaptiveValue.js";
import { transact } from "../src/core/transaction.js";

describe("[Callbacks]", () => {
  test("[MarkingCallback] fired", () => {
    const m = cval(10);
    const d = m.map((v) => v);

    let fired = 0;
    const callback = () => {
      fired += 1;
    };
    const wasFired = () => {
      const v = fired;
      fired = 0;
      return v;
    };

    const sub = d.addMarkingCallback(callback);
    try {
      expect(wasFired()).toBe(0);

      d.force();
      expect(wasFired()).toBe(0);

      transact(() => {
        m.value = 100;
      });
      expect(wasFired()).toBe(1);

      transact(() => {
        m.value = 20;
      });
      expect(wasFired()).toBe(0);

      d.force();
      expect(wasFired()).toBe(0);

      transact(() => {
        m.value = 15;
      });
      expect(wasFired()).toBe(1);
    } finally {
      sub.dispose();
    }
  });

  test("[OnNextMarking] fired", () => {
    const m = cval(10);
    const d = m.map((v) => v);

    let fired = 0;
    const callback = () => {
      fired += 1;
    };
    const wasFired = () => {
      const v = fired;
      fired = 0;
      return v;
    };

    const sub = d.onNextMarking(callback);
    try {
      expect(wasFired()).toBe(0);

      d.force();
      expect(wasFired()).toBe(0);

      transact(() => {
        m.value = 100;
      });
      expect(wasFired()).toBe(1);

      transact(() => {
        m.value = 20;
      });
      expect(wasFired()).toBe(0);

      d.force();
      expect(wasFired()).toBe(0);

      // OnNextMarking only fires once — no further firings even on
      // subsequent marks.
      transact(() => {
        m.value = 15;
      });
      expect(wasFired()).toBe(0);
    } finally {
      sub.dispose();
    }
  });

  test.todo("[AddCallback] surviving GC (deferred to phase 4 — needs aset)");
  test.todo(
    "[AddWeakCallback] not surviving GC (deferred to phase 4 — needs aset)",
  );
});
