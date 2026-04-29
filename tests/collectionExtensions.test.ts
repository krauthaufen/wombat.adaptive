// Smoke tests for CollectionExtensions: AVal.logicalAnd / logicalOr,
// SeqExt.existsA / forallA, AMapExt.keys.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";
import { cmap } from "../src/adaptiveHashMap/changeableHashMap.js";
import {
  AValExt,
  SeqExt,
  AMapExt,
} from "../src/collectionExtensions/collectionExtensions.js";

describe("CollectionExtensions", () => {
  test("AVal.logicalOr witness tracking", () => {
    const a = cval(false);
    const b = cval(false);
    const c = cval(false);
    const r = AValExt.logicalOr([a, b, c]);
    expect(AVal.force(r)).toBe(false);
    transact(() => {
      b.value = true;
    });
    expect(AVal.force(r)).toBe(true);
    transact(() => {
      a.value = true;
    });
    expect(AVal.force(r)).toBe(true);
    transact(() => {
      a.value = false;
      b.value = false;
    });
    expect(AVal.force(r)).toBe(false);
  });

  test("AVal.logicalAnd witness tracking", () => {
    const a = cval(true);
    const b = cval(true);
    const c = cval(true);
    const r = AValExt.logicalAnd([a, b, c]);
    expect(AVal.force(r)).toBe(true);
    transact(() => {
      b.value = false;
    });
    expect(AVal.force(r)).toBe(false);
    transact(() => {
      b.value = true;
    });
    expect(AVal.force(r)).toBe(true);
  });

  test("Seq.existsA / forallA over plain iterables", () => {
    const seen = cval(false);
    const r = SeqExt.existsA(() => seen, [1, 2, 3]);
    expect(AVal.force(r)).toBe(false);
    transact(() => {
      seen.value = true;
    });
    expect(AVal.force(r)).toBe(true);

    const f = SeqExt.forallA(() => seen, [1, 2, 3]);
    expect(AVal.force(f)).toBe(true);
    transact(() => {
      seen.value = false;
    });
    expect(AVal.force(f)).toBe(false);
  });

  test("AMap.keys reflects mutations", () => {
    const m = cmap<number, string>([[1, "a"], [2, "b"]]);
    const ks = AMapExt.keys(m);
    expect([...AVal.force(ks.content)].sort()).toEqual([1, 2]);

    transact(() => m.add(3, "c"));
    expect([...AVal.force(ks.content)].sort()).toEqual([1, 2, 3]);

    transact(() => m.remove(1));
    expect([...AVal.force(ks.content)].sort()).toEqual([2, 3]);

    transact(() => m.set(2, "B"));
    expect([...AVal.force(ks.content)].sort()).toEqual([2, 3]);
  });
});
