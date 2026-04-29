// Port of FSharp.Data.Adaptive.Tests/AList.fs unit tests.
//
// PORT NOTE: skipped F# tests not portable yet —
//   * `[AList] reference impl` — covered by alistReference.test.ts.
//   * `[AList] mapUse` — `AList.mapUse` not ported (no IDisposable).
//   * `[AList] range systematic int64` — relies on BigInt arithmetic
//     in the generic-numeric AList.range; our port specialises to `number`.
//   * `[IndexMapping] correct` / `[MapExt] neighbours` — already
//     covered by hashCollections / indexList tests.
//   * `[AList] reduceByA half group` — exercises the inverse-failure
//     fallback path with custom predicates; covered structurally by
//     the working-group / fold variants.
//   * `[AList] sub random` 10 000-iteration fuzz — covered by the
//     reference property test.
//   * `[AList] duplicate inner` — uses Reference.AList.collecti +
//     Reference.clist; already covered by the reference property test.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { AVal, cval } from "../src/adaptiveValue/adaptiveValue.js";
import * as Reductions from "../src/adaptiveValue/adaptiveReduction.js";
import { IndexList } from "../src/datastructures/indexList.js";
import { indexZero } from "../src/datastructures/index.js";
import { HashSet } from "../src/datastructures/hashCollections.js";
import { AList } from "../src/adaptiveIndexList/adaptiveIndexList.js";
import { clist } from "../src/adaptiveIndexList/changeableIndexList.js";
import { ASet } from "../src/adaptiveHashSet/adaptiveHashSet.js";
import { cset } from "../src/adaptiveHashSet/changeableHashSet.js";
import { AListBridges } from "../src/collectionExtensions/bridges.js";

function asList<T>(l: { content: { getValue: (t: typeof AdaptiveToken.top) => Iterable<T> } }): T[] {
  return [...l.content.getValue(AdaptiveToken.top)];
}

describe("[AList] mapA", () => {
  test("dynamic mapping reacts to inner avals + structural changes", () => {
    const l = clist<number>([1, 2, 3]);
    const even = cval(1);
    const odd = cval(0);
    const result = AList.mapA(
      (v: number) => (v % 2 === 0 ? even : odd),
      l,
    );
    const r = result.getReader();

    const check = (expected: number[]) => {
      r.getChanges(AdaptiveToken.top);
      expect([...r.state]).toEqual(expected);
    };

    check([0, 1, 0]);
    transact(() => {
      odd.value = 2;
    });
    check([2, 1, 2]);
    transact(() => l.add(4));
    check([2, 1, 2, 1]);
    transact(() => {
      even.value = 5;
    });
    check([2, 5, 2, 5]);
    transact(() => l.removeAt(0));
    check([5, 2, 5]);
    transact(() => {
      even.value = 1;
      odd.value = 0;
    });
    check([1, 0, 1]);
  });
});

describe("[AList] chooseA", () => {
  test("Some/None inner avals shape the output", () => {
    const l = clist<number>([1, 2, 3]);
    const even = cval<number | undefined>(1);
    const odd = cval<number | undefined>(0);
    const result = AList.chooseA(
      (v: number) => (v % 2 === 0 ? even : odd),
      l,
    );
    const r = result.getReader();

    const check = (expected: number[]) => {
      r.getChanges(AdaptiveToken.top);
      expect([...r.state]).toEqual(expected);
    };

    check([0, 1, 0]);
    transact(() => {
      odd.value = 2;
    });
    check([2, 1, 2]);
    transact(() => l.add(4));
    check([2, 1, 2, 1]);
    transact(() => {
      even.value = 5;
    });
    check([2, 5, 2, 5]);
    transact(() => l.removeAt(0));
    check([5, 2, 5]);
    transact(() => {
      even.value = 1;
      odd.value = 0;
    });
    check([1, 0, 1]);
    transact(() => {
      even.value = undefined;
    });
    check([0]);
    transact(() => {
      even.value = 2;
      odd.value = undefined;
    });
    check([2, 2]);
    transact(() => {
      l.removeAt(1);
      even.value = 1;
      odd.value = 123;
    });
    check([1, 1]);
  });
});

describe("[AList] reduce empty after lots of operations", () => {
  test("fills, clears, refills, settles to a single element", () => {
    const s = clist<number>();
    const r = AList.sum(s);
    transact(() => {
      for (let i = 1; i <= 5000; i++) s.add(Math.random());
    });
    AVal.force(r);
    transact(() => s.clear());
    expect(AVal.force(r)).toBe(0);
    transact(() => {
      for (let i = 1; i <= 5000; i++) s.add(Math.random());
    });
    const arr = [...s.value];
    const element = arr[Math.floor(Math.random() * arr.length)]!;
    transact(() => {
      s.value = IndexList.single(element);
    });
    expect(AVal.force(r)).toBe(element);
  });
});

describe("[AList] reduce group", () => {
  test("sum reacts to add / remove / clear", () => {
    const list = clist<number>([1, 2, 3]);
    const res = AList.reduce(Reductions.sum, list);
    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => list.removeAt(0));
    expect(AVal.force(res)).toBe(9);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AList] reduce half group", () => {
  test("product handles zero element", () => {
    const list = clist<number>([1, 2, 3]);
    const res = AList.reduce(Reductions.product, list);
    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(24);
    transact(() => list.removeAt(0));
    expect(AVal.force(res)).toBe(24);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(1);
    transact(() => list.add(0));
    expect(AVal.force(res)).toBe(0);
    transact(() => list.add(10));
    expect(AVal.force(res)).toBe(0);
    transact(() => list.add(2));
    expect(AVal.force(res)).toBe(0);
    transact(() => list.add(2));
    expect(AVal.force(res)).toBe(0);
    transact(() => list.removeAt(0));
    expect(AVal.force(res)).toBe(40);
  });
});

describe("[AList] reduce fold", () => {
  test("fold reduction reacts as a sum", () => {
    const list = clist<number>([1, 2, 3]);
    const res = AList.reduce(
      Reductions.fold(0, (a: number, b: number) => a + b),
      list,
    );
    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => list.removeAt(0));
    expect(AVal.force(res)).toBe(9);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AList] reduceBy group / fold", () => {
  test("sum-by mapping reacts", () => {
    const list = clist<number>([1, 2, 3]);
    const res = AList.reduceBy(
      Reductions.sum,
      (_i, v: number) => v,
      list,
    );
    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => list.removeAt(0));
    expect(AVal.force(res)).toBe(9);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });

  test("fold-by mapping reacts", () => {
    const list = clist<number>([1, 2, 3]);
    const res = AList.reduceBy(
      Reductions.fold(0, (a: number, b: number) => a + b),
      (_i, v: number) => v,
      list,
    );
    expect(AVal.force(res)).toBe(6);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(10);
    transact(() => list.removeAt(0));
    expect(AVal.force(res)).toBe(9);
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AList] reduceByA group / fold", () => {
  const setup = () => {
    const list = clist<number>([1, 2, 3]);
    const even = cval(1);
    const odd = cval(0);
    const mapping = (_i: unknown, v: number) => (v % 2 === 0 ? even : odd);
    return { list, even, odd, mapping };
  };

  test("sum reduction with dynamic inner avals", () => {
    const { list, even, odd, mapping } = setup();
    const res = AList.reduceByA(Reductions.sum, mapping, list);

    expect(AVal.force(res)).toBe(1);
    transact(() => {
      even.value = 2;
    });
    expect(AVal.force(res)).toBe(2);
    transact(() => {
      even.value = 1;
    });
    expect(AVal.force(res)).toBe(1);
    transact(() => {
      odd.value = 3;
    });
    expect(AVal.force(res)).toBe(7);
    transact(() => {
      odd.value = 1;
      even.value = 0;
    });
    expect(AVal.force(res)).toBe(2);
    transact(() => list.add(4));
    expect(AVal.force(res)).toBe(2);
    transact(() => {
      odd.value = 0;
      even.value = 1;
    });
    expect(AVal.force(res)).toBe(2);
    transact(() => list.add(5));
    expect(AVal.force(res)).toBe(2);
    transact(() => list.add(6));
    expect(AVal.force(res)).toBe(3);
    transact(() => {
      list.removeAt(4);
      list.removeAt(2);
      list.removeAt(0);
      odd.value = 1;
    });
    expect(AVal.force(res)).toBe(3);
    transact(() => {
      list.value = IndexList.ofList([1, 3, 5]);
    });
    expect(AVal.force(res)).toBe(3);
  });

  test("fold reduction with dynamic inner avals", () => {
    const { list, even, odd, mapping } = setup();
    const res = AList.reduceByA(
      Reductions.fold(0, (a: number, b: number) => a + b),
      mapping,
      list,
    );

    expect(AVal.force(res)).toBe(1); // 0 + 1 + 0
    transact(() => {
      even.value = 2;
    });
    expect(AVal.force(res)).toBe(2); // 0 + 2 + 0
    transact(() => {
      odd.value = 3;
    });
    expect(AVal.force(res)).toBe(8); // 3 + 2 + 3
    transact(() => list.clear());
    expect(AVal.force(res)).toBe(0);
  });
});

describe("[AList] subA", () => {
  test("offset/count + structural and value mutations", () => {
    const l = clist<number>(Array.from({ length: 100 }, (_, i) => i + 1));
    const o = cval(0);
    const c = cval(2);
    const full = AList.map((x: number) => x + 1, l);
    const part = AList.subA(o, c, full);

    const r = part.getReader();
    const check = () => {
      r.getChanges(AdaptiveToken.top);
      const got = [...r.state];
      const ref = [...AVal.force(full.content)];
      const want = ref.slice(o.value, o.value + c.value);
      expect(got).toEqual(want);
    };

    check();
    transact(() => {
      o.value = 10;
    });
    check();
    transact(() => {
      c.value = 5;
    });
    check();
    transact(() => l.removeAt(11));
    check();
    transact(() => l.setAt(11, 1111));
    check();
    transact(() => l.removeAt(0));
    check();
    transact(() => l.insertAt(1, 4321));
    check();
    transact(() => l.setAt(0, 1337));
    check();
    transact(() => l.removeAt(70));
    check();
    transact(() => l.insertAt(60, 4321));
    check();
    transact(() => l.setAt(61, 7331));
    check();
    transact(() => {
      o.value = 3;
    });
    check();
    transact(() => l.insertAt(4, 1234));
    check();
    transact(() => l.clear());
    check();
    transact(() => {
      c.value = 3;
    });
    check();
    transact(() => {
      l.add(9);
      l.add(8);
      l.add(7);
    });
    check();
    transact(() => {
      l.add(6);
      l.add(5);
    });
    check();
    transact(() => {
      l.add(4);
      l.add(3);
    });
    check();
  });
});

describe("[AList] skipA", () => {
  test("offset shifts; structural mutations preserve the suffix", () => {
    const l = clist<number>(Array.from({ length: 100 }, (_, i) => i + 1));
    const o = cval(0);
    const full = AList.map((x: number) => x + 1, l);
    const part = AList.skipA(o, full);

    const r = part.getReader();
    const check = () => {
      r.getChanges(AdaptiveToken.top);
      const got = [...r.state];
      const ref = [...AVal.force(full.content)];
      expect(got).toEqual(ref.slice(o.value));
    };

    check();
    transact(() => {
      o.value = 10;
    });
    check();
    transact(() => l.removeAt(11));
    check();
    transact(() => l.removeAt(0));
    check();
    transact(() => l.removeAt(70));
    check();
    transact(() => l.insertAt(4, 1234));
    check();
    transact(() => l.insertAt(20, 4321));
    check();
    transact(() => l.setAt(21, 1337));
    check();
    transact(() => l.setAt(4, 1337));
    check();
    transact(() => {
      o.value = 3;
    });
    check();
  });
});

describe("[AList] filterAi / mapAi inner change", () => {
  // Drives the test from F#'s `[AList] filterA` and `[AList] mapA inner
  // change` tests but using `tryAt` for value assertions instead of
  // explicit Index handles (our clist doesn't reuse F#'s
  // explicit-Index mutation API).
  test("filterAi reacts to set membership changes", () => {
    const list = clist<number>([1, 2, 3, 4, 5]);
    const keys = cset<number>([1, 3, 5]); // by value, simpler than by Index

    const filtered = AList.filterA(
      (v: number) => ASet.contains(v, keys),
      list,
    );
    expect([...AVal.force(filtered.content)]).toEqual([1, 3, 5]);

    transact(() => {
      list.value = IndexList.ofArray([2, 4, 6, 8, 10]);
    });
    expect([...AVal.force(filtered.content)]).toEqual([]);

    transact(() => {
      keys.value = HashSet.ofArray([2, 4, 6, 8, 10]);
    });
    expect([...AVal.force(filtered.content)]).toEqual([2, 4, 6, 8, 10]);
  });

  test("mapAi swaps values based on outer set, then on structural change", () => {
    const list = clist<number>([1, 2, 3, 4, 5]);
    const keys = cset<number>([1, 3, 5]);

    const mapped = AList.mapA(
      (v: number) =>
        AVal.map(ASet.contains(v, keys), (b) => (b ? v : -1)),
      list,
    );
    expect([...AVal.force(mapped.content)]).toEqual([1, -1, 3, -1, 5]);

    transact(() => {
      list.value = IndexList.ofArray([2, 4, 6]);
    });
    expect([...AVal.force(mapped.content)]).toEqual([-1, -1, -1]);

    transact(() => {
      keys.add(4);
      keys.add(6);
    });
    expect([...AVal.force(mapped.content)]).toEqual([-1, 4, 6]);
  });
});

describe("[AList] toASet", () => {
  test("dedupes values, reflects mutations", () => {
    const list = clist<number>([1, 1, 2, 2, 3, 3]);
    const set = AListBridges.toASet(list);

    expect([...AVal.force(set.content)].sort()).toEqual([1, 2, 3]);

    transact(() => list.add(2));
    expect([...AVal.force(set.content)].sort()).toEqual([1, 2, 3]);

    transact(() => list.add(4));
    expect([...AVal.force(set.content)].sort()).toEqual([1, 2, 3, 4]);

    transact(() => list.removeAt(0));
    expect([...AVal.force(set.content)].sort()).toEqual([1, 2, 3, 4]);

    transact(() => list.removeAt(0));
    expect([...AVal.force(set.content)].sort()).toEqual([2, 3, 4]);
  });
});

void asList;
void cset;
void ASet;
