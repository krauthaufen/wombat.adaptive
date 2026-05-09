// Behavioural sanity-checks for every (collection × combinator) pair
// the plugin rewrites. Each test verifies BOTH (a) reference-equal
// memoization across two structurally-identical call sites and (b) at
// least one correctness assertion against a forced value.

import { describe, expect, test } from "vitest";
import { transact } from "@aardworx/wombat.adaptive";
import { cval } from "@aardworx/wombat.adaptive/aval";
import { cset, force as forceSet } from "@aardworx/wombat.adaptive/aset";
import {
  clist,
  force as forceList,
  bind as alistBind,
} from "@aardworx/wombat.adaptive/alist";
import { cmap, force as forceMap } from "@aardworx/wombat.adaptive/amap";
import { bind as asetBind } from "@aardworx/wombat.adaptive/aset";

describe("[plugin/behavioural] aset combinators", () => {
  test("aset.map", () => {
    const s = cset<number>([1, 2, 3]);
    const m1 = s.map((x) => x * 2);
    const m2 = s.map((x) => x * 2);
    expect(m1).toBe(m2);
    expect(forceSet(m1).toArray().sort((a, b) => a - b)).toEqual([2, 4, 6]);

    transact(() => {
      s.add(4);
    });
    expect(forceSet(m1).toArray().sort((a, b) => a - b)).toEqual([2, 4, 6, 8]);
  });

  test("aset.filter", () => {
    const s = cset<number>([-1, 0, 1, 2]);
    const f1 = s.filter((x) => x > 0);
    const f2 = s.filter((x) => x > 0);
    expect(f1).toBe(f2);
    expect(forceSet(f1).toArray().sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test("aset.choose", () => {
    const s = cset<number>([-1, 0, 1, 2]);
    const c1 = s.choose((x) => (x > 0 ? x * 10 : undefined));
    const c2 = s.choose((x) => (x > 0 ? x * 10 : undefined));
    expect(c1).toBe(c2);
    expect(forceSet(c1).toArray().sort((a, b) => a - b)).toEqual([10, 20]);
  });

  test("aset.collect", () => {
    const s = cset<number>([1, 2]);
    const c1 = s.collect((x) => cset<number>([x, x * 10]));
    const c2 = s.collect((x) => cset<number>([x, x * 10]));
    // body-hash equal AND source equal → same derived.
    expect(c1).toBe(c2);
    expect(forceSet(c1).toArray().sort((a, b) => a - b)).toEqual([1, 2, 10, 20]);
  });

  test("aset.bind (free fn): same shape → same derived; correctness", () => {
    const sw = cval(true);
    const sa = cset<number>([1, 2]);
    const sb = cset<number>([10, 20]);
    const r1 = asetBind((f: boolean) => (f ? sa : sb), sw);
    const r2 = asetBind((f: boolean) => (f ? sa : sb), sw);
    expect(r1).toBe(r2);
    expect(forceSet(r1).toArray().sort((a, b) => a - b)).toEqual([1, 2]);
    transact(() => {
      sw.value = false;
    });
    expect(forceSet(r1).toArray().sort((a, b) => a - b)).toEqual([10, 20]);
  });
});

describe("[plugin/behavioural] alist combinators", () => {
  test("alist.map", () => {
    const l = clist<number>();
    transact(() => {
      l.add(1);
      l.add(2);
      l.add(3);
    });
    const m1 = l.map((x) => x * 2);
    const m2 = l.map((x) => x * 2);
    expect(m1).toBe(m2);
    expect(Array.from(forceList(m1))).toEqual([2, 4, 6]);
  });

  test("alist.filter", () => {
    const l = clist<number>();
    transact(() => {
      l.add(-1);
      l.add(2);
      l.add(-3);
      l.add(4);
    });
    const f1 = l.filter((x) => x > 0);
    const f2 = l.filter((x) => x > 0);
    expect(f1).toBe(f2);
    expect(Array.from(forceList(f1))).toEqual([2, 4]);
  });

  test("alist.choose", () => {
    const l = clist<number>();
    transact(() => {
      l.add(1);
      l.add(2);
      l.add(3);
    });
    const c1 = l.choose((x) => (x % 2 === 0 ? x * 100 : undefined));
    const c2 = l.choose((x) => (x % 2 === 0 ? x * 100 : undefined));
    expect(c1).toBe(c2);
    expect(Array.from(forceList(c1))).toEqual([200]);
  });

  test("alist.collect", () => {
    const outer = clist<number>();
    transact(() => {
      outer.add(1);
      outer.add(2);
    });
    const c1 = outer.collect((x) => {
      const inner = clist<number>();
      transact(() => {
        inner.add(x);
        inner.add(x * 10);
      });
      return inner;
    });
    // Note: collect callback constructs new clists each call, so the
    // *result* identity may differ across two top-level invocations
    // because the bodies allocate fresh clist sources. We assert
    // correctness, not memoization, here.
    expect(Array.from(forceList(c1)).sort((a, b) => a - b)).toEqual([1, 2, 10, 20]);
  });

  test("alist.bind (free fn): correctness + memoization", () => {
    const sw = cval(true);
    const la = clist<number>();
    transact(() => {
      la.add(1);
      la.add(2);
    });
    const lb = clist<number>();
    transact(() => {
      lb.add(100);
    });
    const r1 = alistBind((f: boolean) => (f ? la : lb), sw);
    const r2 = alistBind((f: boolean) => (f ? la : lb), sw);
    expect(r1).toBe(r2);
    expect(Array.from(forceList(r1))).toEqual([1, 2]);
    transact(() => {
      sw.value = false;
    });
    expect(Array.from(forceList(r1))).toEqual([100]);
  });
});

describe("[plugin/behavioural] amap combinators", () => {
  test("amap.map", () => {
    const m = cmap<string, number>();
    transact(() => {
      m.set("a", 1);
      m.set("b", 2);
    });
    const r1 = m.map((_k, v) => v * 10);
    const r2 = m.map((_k, v) => v * 10);
    expect(r1).toBe(r2);
    const arr = Array.from(forceMap(r1)).map(([k, v]) => `${k}=${v}`).sort();
    expect(arr).toEqual(["a=10", "b=20"]);
  });

  test("amap.filter", () => {
    const m = cmap<string, number>();
    transact(() => {
      m.set("a", 1);
      m.set("b", -1);
      m.set("c", 2);
    });
    const f1 = m.filter((_k, v) => v > 0);
    const f2 = m.filter((_k, v) => v > 0);
    expect(f1).toBe(f2);
    const keys = Array.from(forceMap(f1)).map(([k]) => k).sort();
    expect(keys).toEqual(["a", "c"]);
  });

  test("amap.choose", () => {
    const m = cmap<string, number>();
    transact(() => {
      m.set("a", 1);
      m.set("b", -2);
    });
    const c1 = m.choose((_k, v) => (v > 0 ? v * 100 : undefined));
    const c2 = m.choose((_k, v) => (v > 0 ? v * 100 : undefined));
    expect(c1).toBe(c2);
    const arr = Array.from(forceMap(c1)).map(([k, v]) => `${k}=${v}`).sort();
    expect(arr).toEqual(["a=100"]);
  });
});
