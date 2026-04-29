// Port of FSharp.Data.Adaptive.Tests/History.fs
//
// PORT NOTE: skipped the `[History] weak` test — it relies on real-memory
// measurement (`getRealMemory`/`ensureGC`) and HugeOp byte allocations that
// don't translate to JS GC behavior.

import { describe, expect, test } from "vitest";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { transact } from "../src/core/transaction.js";
import { HashSetDelta } from "../src/datastructures/hashSetDelta.js";
import { SetOperation } from "../src/datastructures/operations.js";
import { CountingHashSet } from "../src/traceable/countingHashSet.js";
import { History, type IOpReader } from "../src/traceable/history.js";

const top = AdaptiveToken.top;

function add(v: number): SetOperation<number> {
  return SetOperation.add(v);
}
function rem(v: number): SetOperation<number> {
  return SetOperation.rem(v);
}

function changeSet(
  history: History<CountingHashSet<number>, HashSetDelta<number>>,
  ops: SetOperation<number>[],
): void {
  transact(() => {
    history.perform(HashSetDelta.ofList(ops));
  });
}

function pull(r: IOpReader<HashSetDelta<number>>): SetOperation<number>[] {
  const d = r.getChanges(top);
  return [...d];
}

function setEqual(
  actual: SetOperation<number>[],
  expected: SetOperation<number>[],
): void {
  const norm = (xs: SetOperation<number>[]) =>
    xs
      .map((o) => `${o.count > 0 ? "+" : "-"}${o.value}`)
      .sort();
  expect(norm(actual)).toEqual(norm(expected));
}

describe("[History] different reader versions", () => {
  test("readers on three versions converge", () => {
    // tcomputeDelta is supposed to be unused in this scenario except for
    // empty-base recomputation — F# uses a guarded delta that fails if
    // the base is non-empty. We mirror that to catch regressions.
    const baseTrace = CountingHashSet.trace<number>();
    const trace = {
      ...baseTrace,
      tcomputeDelta: (a: CountingHashSet<number>, b: CountingHashSet<number>) => {
        if (a.isEmpty) return baseTrace.tcomputeDelta(a, b);
        throw new Error("tcomputeDelta should not be called for non-empty base");
      },
    };
    const history = History.create(trace);

    const r0 = history.newReader();
    const r1 = history.newReader();
    const r2 = history.newReader();

    setEqual(pull(r0), []);
    setEqual(pull(r1), []);
    setEqual(pull(r2), []);

    changeSet(history, [add(1)]);
    setEqual(pull(r1), [add(1)]);

    changeSet(history, [add(2)]);
    setEqual(pull(r2), [add(1), add(2)]);

    changeSet(history, [add(3)]);
    setEqual(pull(r0), [add(1), add(2), add(3)]);
    setEqual(pull(r1), [add(2), add(3)]);
    setEqual(pull(r2), [add(3)]);

    changeSet(history, [rem(2)]);
    setEqual(pull(r0), [rem(2)]);
    setEqual(pull(r1), [rem(2)]);
    setEqual(pull(r2), [rem(2)]);

    const r3 = history.newReader();
    setEqual(pull(r3), [add(1), add(3)]);

    changeSet(history, [rem(3)]);
    setEqual(pull(r0), [rem(3)]);
    setEqual(pull(r1), [rem(3)]);
    setEqual(pull(r2), [rem(3)]);
    setEqual(pull(r3), [rem(3)]);
  });
});

describe("[History] single reader", () => {
  test("delta then state", () => {
    const h = History.create(CountingHashSet.trace<number>());
    const r = h.newReader();

    transact(() => {
      h.perform(HashSetDelta.ofList([add(1), add(2)]));
    });

    setEqual(pull(r), [add(1), add(2)]);
    expect([...r.state.toHashSet()].sort()).toEqual([1, 2]);

    transact(() => {
      h.perform(HashSetDelta.ofList([rem(1)]));
    });

    setEqual(pull(r), [rem(1)]);
    expect([...r.state.toHashSet()]).toEqual([2]);
  });
});

describe("[History] multiple readers", () => {
  test("auxiliary readers do not disturb primary", () => {
    const h = History.create(CountingHashSet.trace<number>());
    const r = h.newReader();

    const secondReader = () => {
      h.newReader();
    };

    transact(() => {
      h.perform(HashSetDelta.ofList([add(1), add(2)]));
    });
    secondReader();

    setEqual(pull(r), [add(1), add(2)]);
    expect([...r.state.toHashSet()].sort()).toEqual([1, 2]);

    secondReader();

    transact(() => {
      h.perform(HashSetDelta.ofList([rem(1)]));
    });
    secondReader();

    setEqual(pull(r), [rem(1)]);
    expect([...r.state.toHashSet()]).toEqual([2]);
  });
});
