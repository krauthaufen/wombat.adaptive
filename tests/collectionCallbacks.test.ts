// Tests for aset/amap/alist `addCallback`-style subscriptions.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { cset } from "../src/adaptiveHashSet/changeableHashSet.js";
import { cmap } from "../src/adaptiveHashMap/changeableHashMap.js";
import { clist } from "../src/adaptiveIndexList/changeableIndexList.js";
import {
  asetCallback,
  amapCallback,
  alistCallback,
} from "../src/collectionExtensions/callbacks.js";

describe("collection callbacks", () => {
  // Callback semantics (matches F# EvaluationCallbackExtensions):
  //   action(state, delta) is invoked with the state BEFORE the
  //   delta is applied. The first call fires with state = empty
  //   and delta = empty→current.
  test("aset fires once initially then on each transaction", () => {
    const s = cset<number>([1, 2]);
    const calls: Array<{ size: number; deltaCount: number }> = [];
    const sub = asetCallback(s, (state, delta) => {
      calls.push({ size: state.count, deltaCount: delta.count });
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ size: 0, deltaCount: 2 });

    transact(() => s.add(3));
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual({ size: 2, deltaCount: 1 });

    transact(() => {
      s.add(4);
      s.remove(1);
    });
    expect(calls.length).toBe(3);
    expect(calls[2]).toEqual({ size: 3, deltaCount: 2 });

    sub.dispose();
    transact(() => s.add(99));
    expect(calls.length).toBe(3); // no further calls after dispose
  });

  test("amap delivers prior state + delta", () => {
    const m = cmap<string, number>([["a", 1]]);
    const states: number[] = [];
    const sub = amapCallback(m, (state) => {
      states.push(state.count);
    });
    expect(states).toEqual([0]); // empty before initial delta
    transact(() => m.add("b", 2));
    expect(states).toEqual([0, 1]);
    transact(() => m.remove("a"));
    expect(states).toEqual([0, 1, 2]);
    sub.dispose();
  });

  test("alist callback fires for structural changes", () => {
    const l = clist<number>([10, 20]);
    const sizes: number[] = [];
    const sub = alistCallback(l, (state) => {
      sizes.push(state.count);
    });
    expect(sizes).toEqual([0]); // empty before initial delta
    transact(() => l.add(30));
    expect(sizes).toEqual([0, 2]);
    transact(() => l.removeAt(0));
    expect(sizes).toEqual([0, 2, 3]);
    sub.dispose();
  });
});
