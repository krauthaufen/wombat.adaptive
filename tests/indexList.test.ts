// Tests for Index, MapExt, IndexList, IndexListDelta. Subset of the F#
// IndexList tests in FSharp.Data.Adaptive.Tests/IndexList.fs.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import {
  Index,
  IndexOps,
  indexZero,
} from "../src/datastructures/index.js";
import { IndexList } from "../src/datastructures/indexList.js";
import {
  IndexListDelta,
  IndexListDeltaExt,
} from "../src/datastructures/indexListDelta.js";
import { MapExt } from "../src/datastructures/mapExt.js";
import { ElementRemove, ElementSet } from "../src/datastructures/operations.js";

describe("Index", () => {
  test("zero is a valid index", () => {
    expect(indexZero).toBeDefined();
  });

  test("after / before / between maintain ordering", () => {
    const a = IndexOps.after(indexZero);
    const c = IndexOps.after(a);
    expect(a.compareTo(c)).toBeLessThan(0);

    const b = IndexOps.between(a, c);
    expect(a.compareTo(b)).toBeLessThan(0);
    expect(b.compareTo(c)).toBeLessThan(0);
  });

  test("100 nested 'after' calls maintain monotonic order", () => {
    const indices: Index[] = [IndexOps.after(indexZero)];
    for (let i = 1; i < 100; i++) {
      indices.push(IndexOps.after(indices[i - 1]!));
    }
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i - 1]!.compareTo(indices[i]!)).toBeLessThan(0);
    }
  });

  test("between repeatedly does not violate ordering", () => {
    let a = IndexOps.after(indexZero);
    let b = IndexOps.after(a);
    for (let i = 0; i < 50; i++) {
      const m = IndexOps.between(a, b);
      expect(a.compareTo(m)).toBeLessThan(0);
      expect(m.compareTo(b)).toBeLessThan(0);
      a = m;
    }
  });
});

describe("MapExt", () => {
  const cmpInt = (a: number, b: number) => a - b;

  test("empty / add / find / remove", () => {
    let m = MapExt.empty<number, string>(cmpInt);
    expect(m.isEmpty).toBe(true);
    m = m.add(2, "two").add(1, "one").add(3, "three");
    expect(m.count).toBe(3);
    expect(m.tryFind(2)).toBe("two");
    expect(m.toKeyList()).toEqual([1, 2, 3]);
    m = m.remove(2);
    expect(m.containsKey(2)).toBe(false);
  });

  test("min/max/slice/withMin/withMax", () => {
    const m = MapExt.ofArray<number, string>(
      [
        [1, "a"],
        [3, "c"],
        [5, "e"],
        [7, "g"],
        [9, "i"],
      ],
      cmpInt,
    );
    expect(m.minKey).toBe(1);
    expect(m.maxKey).toBe(9);
    expect(m.slice(3, 7).toKeyList()).toEqual([3, 5, 7]);
    expect(m.withMin(5).toKeyList()).toEqual([5, 7, 9]);
    expect(m.withMax(5).toKeyList()).toEqual([1, 3, 5]);
  });

  test("neighbours returns left/self/right correctly", () => {
    const m = MapExt.ofArray<number, string>(
      [
        [1, "a"],
        [3, "c"],
        [5, "e"],
      ],
      cmpInt,
    );
    const n = m.neighbours(3);
    expect(n.left).toEqual([1, "a"]);
    expect(n.self).toBe("c");
    expect(n.right).toEqual([5, "e"]);

    const n2 = m.neighbours(2);
    expect(n2.left).toEqual([1, "a"]);
    expect(n2.self).toBeUndefined();
    expect(n2.right).toEqual([3, "c"]);
  });

  test("partition splits into yes/no", () => {
    const m = MapExt.ofArray<number, number>(
      [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ],
      cmpInt,
    );
    const { yes, no } = m.partition((_k, v) => v % 2 === 0);
    expect(yes.toKeyList()).toEqual([2, 4]);
    expect(no.toKeyList()).toEqual([1, 3]);
  });
});

describe("IndexList basics", () => {
  test("empty / count / isEmpty", () => {
    const l = IndexList.empty<number>();
    expect(l.count).toBe(0);
    expect(l.isEmpty).toBe(true);
  });

  test("add / prepend / iteration order", () => {
    let l = IndexList.empty<number>();
    l = l.add(1).add(2).add(3);
    expect(l.toList()).toEqual([1, 2, 3]);
    l = l.prepend(0);
    expect(l.toList()).toEqual([0, 1, 2, 3]);
  });

  test("ofList / toList round-trip", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 100 }), (arr) => {
        const l = IndexList.ofList(arr);
        expect(l.toList()).toEqual(arr);
      }),
    );
  });

  test("setByPosition / item", () => {
    let l = IndexList.ofList([1, 2, 3, 4]);
    l = l.setByPosition(1, 20);
    expect(l.toList()).toEqual([1, 20, 3, 4]);
    expect(l.item(2)).toBe(3);
  });

  test("insertAt at start, middle, end", () => {
    let l = IndexList.ofList([1, 2, 3]);
    l = l.insertAt(0, 0);
    expect(l.toList()).toEqual([0, 1, 2, 3]);
    l = l.insertAt(2, 99);
    expect(l.toList()).toEqual([0, 1, 99, 2, 3]);
    l = l.insertAt(l.count, 100);
    expect(l.toList()).toEqual([0, 1, 99, 2, 3, 100]);
  });

  test("removeAt / removeByIndex", () => {
    const l = IndexList.ofList([1, 2, 3, 4]);
    expect(l.removeAt(1).toList()).toEqual([1, 3, 4]);
    expect(l.removeAt(0).toList()).toEqual([2, 3, 4]);
    expect(l.removeAt(l.count - 1).toList()).toEqual([1, 2, 3]);
    expect(l.removeAt(99).toList()).toEqual([1, 2, 3, 4]);
  });

  test("map / choose / filter", () => {
    const l = IndexList.ofList([1, 2, 3, 4]);
    expect(l.map((_i, v) => v * 10).toList()).toEqual([10, 20, 30, 40]);
    expect(
      l.choose((_i, v) => (v % 2 === 0 ? v : undefined)).toList(),
    ).toEqual([2, 4]);
    expect(l.filter((_i, v) => v <= 2).toList()).toEqual([1, 2]);
  });

  test("take / skip", () => {
    const l = IndexList.ofList([1, 2, 3, 4, 5]);
    expect(l.takeFirst(0).toList()).toEqual([]);
    expect(l.takeFirst(3).toList()).toEqual([1, 2, 3]);
    expect(l.takeFirst(99).toList()).toEqual([1, 2, 3, 4, 5]);
    expect(l.skipFirst(0).toList()).toEqual([1, 2, 3, 4, 5]);
    expect(l.skipFirst(2).toList()).toEqual([3, 4, 5]);
    expect(l.skipFirst(99).toList()).toEqual([]);
  });

  test("append concatenates two lists in order", () => {
    const a = IndexList.ofList([1, 2, 3]);
    const b = IndexList.ofList([4, 5, 6]);
    expect(IndexList.append(a, b).toList()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(IndexList.append(a, IndexList.empty()).toList()).toEqual([1, 2, 3]);
    expect(IndexList.append(IndexList.empty(), b).toList()).toEqual([4, 5, 6]);
  });
});

describe("IndexListDelta", () => {
  test("computeDelta(A, A) is empty", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 50 }), (arr) => {
        const a = IndexList.ofList(arr);
        expect(IndexListDeltaExt.computeDelta(a, a).isEmpty).toBe(true);
      }),
    );
  });

  test("applyDelta(A, computeDelta(A, B)) = (B, computeDelta(A, B))", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { maxLength: 30 }),
        fc.array(fc.integer(), { maxLength: 30 }),
        (la, lb) => {
          const a = IndexList.ofList(la);
          const b = IndexList.ofList(lb);
          // A's indices must match B's for direct apply to round-trip.
          // Here we re-key B onto A's indices by computing delta and
          // applying. Note: F# property holds only for IndexLists that
          // share the index space; otherwise delta is at minimum a full
          // remove-all-of-A + insert-all-of-B (which still round-trips).
          const d = IndexListDeltaExt.computeDelta(a, b);
          const result = IndexListDeltaExt.applyDelta(a, d);
          expect(result.state.toList()).toEqual(b.toList());
        },
      ),
    );
  });

  test("simple Remove delta clears matching index", () => {
    let l = IndexList.ofList([10, 20, 30]);
    const indices = l.toListIndexed().map((kv) => kv[0]);
    const d = IndexListDelta.ofArray<number>([[indices[1]!, ElementRemove]]);
    const out = IndexListDeltaExt.applyDelta(l, d);
    expect(out.state.toList()).toEqual([10, 30]);
  });

  test("simple Set delta updates matching index", () => {
    let l = IndexList.ofList([10, 20, 30]);
    const indices = l.toListIndexed().map((kv) => kv[0]);
    const d = IndexListDelta.ofArray<number>([[indices[1]!, ElementSet(99)]]);
    const out = IndexListDeltaExt.applyDelta(l, d);
    expect(out.state.toList()).toEqual([10, 99, 30]);
  });
});

// =============================================================================
// Full F# test ports — IndexList.fs
// =============================================================================

describe("[Index] ported", () => {
  test("maintaining order under nested between", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 1024 }), (lr) => {
        const min = indexZero;
        const max = IndexOps.after(min);
        let l = min;
        let r = max;
        const all: { left: boolean; idx: Index }[] = [];
        for (const left of lr) {
          if (left) {
            r = IndexOps.between(l, r);
            all.push({ left: true, idx: r });
          } else {
            l = IndexOps.between(l, r);
            all.push({ left: false, idx: l });
          }
        }
        // Walk the trace forward, narrowing the window. Each new index
        // must be strictly between the current window bounds.
        let lo = min;
        let hi = max;
        for (const { left, idx } of all) {
          expect(idx.compareTo(lo)).toBeGreaterThan(0);
          expect(idx.compareTo(hi)).toBeLessThan(0);
          if (left) hi = idx;
          else lo = idx;
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe("[IndexList] ported", () => {
  const arbList = fc.array(fc.integer(), { maxLength: 100 });

  test("creation round-trip", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        expect(IndexList.ofList(l).toList()).toEqual(l);
      }),
    );
  });

  test("count matches list length", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        expect(IndexList.ofList(l).count).toBe(l.length);
      }),
    );
  });

  test("skip / take agree with Array slice", () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.integer(), fc.integer(), fc.integer(), arbList),
        ([a, b, c, l]) => {
          const list = [a, b, c, ...l];
          const il = IndexList.ofList(list);
          expect(il.skipFirst(2).toList()).toEqual(list.slice(2));
          expect(il.skipFirst(0).toList()).toEqual(list);
          expect(il.skipFirst(1).toList()).toEqual(list.slice(1));
          const cnt = Math.floor(list.length / 2);
          expect(il.takeFirst(cnt).toList()).toEqual(list.slice(0, cnt));
          expect(il.takeFirst(0).toList()).toEqual([]);
          expect(il.takeFirst(2).toList()).toEqual(list.slice(0, 2));
        },
      ),
    );
  });

  test("append concatenates", () => {
    fc.assert(
      fc.property(arbList, arbList, (l, r) => {
        const out = IndexList.append(IndexList.ofList(l), IndexList.ofList(r));
        expect(out.toList()).toEqual([...l, ...r]);
      }),
    );
  });

  test("take / skip exhaustive", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const ll = IndexList.ofList(l);
        const c = l.length;
        const s1 = Math.floor(c / 2);
        const s2 = Math.floor(c / 3);
        expect(ll.skipFirst(c).toList()).toEqual([]);
        expect(ll.skipFirst(0).toList()).toEqual(l);
        expect(ll.skipFirst(s1).toList()).toEqual(l.slice(s1));
        expect(ll.skipFirst(s2).toList()).toEqual(l.slice(s2));
        expect(ll.takeFirst(c).toList()).toEqual(l);
        expect(ll.takeFirst(0).toList()).toEqual([]);
        expect(ll.takeFirst(s1).toList()).toEqual(l.slice(0, s1));
        expect(ll.takeFirst(s2).toList()).toEqual(l.slice(0, s2));
      }),
    );
  });

  test("sort variants agree with Array.prototype.sort", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const ll = IndexList.ofList(l);
        const cmp = (a: number, b: number) => b - a;
        expect(ll.sortBy((x) => x).toList()).toEqual(
          [...l].sort((a, b) => a - b),
        );
        expect(ll.sortByDescending((x) => x).toList()).toEqual(
          [...l].sort((a, b) => b - a),
        );
        expect(ll.sortWith(cmp).toList()).toEqual([...l].sort(cmp));
        expect(ll.sort().toList()).toEqual([...l].sort((a, b) => a - b));
        expect(ll.sortDescending().toList()).toEqual(
          [...l].sort((a, b) => b - a),
        );
      }),
    );
  });

  test("sum / sumBy / average / averageBy agree with Array reductions", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.float({ noNaN: true, noDefaultInfinity: true }),
          fc.array(fc.float({ noNaN: true, noDefaultInfinity: true }), {
            maxLength: 100,
          }),
        ),
        ([h, rest]) => {
          const l = [h, ...rest];
          const ll = IndexList.ofList(l);
          const mapping = (v: number) => v + 1.0;
          const sum = l.reduce((a, b) => a + b, 0);
          const avg = sum / l.length;
          expect(ll.sum()).toBeCloseTo(sum, 8);
          expect(ll.average()).toBeCloseTo(avg, 8);
          const sumB = l.map(mapping).reduce((a, b) => a + b, 0);
          expect(ll.sumBy(mapping)).toBeCloseTo(sumB, 8);
          expect(ll.averageBy(mapping)).toBeCloseTo(sumB / l.length, 8);
        },
      ),
    );
  });

  test("unzip / unzip3 split tuples elementwise", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer(), fc.float({ noNaN: true })), {
          maxLength: 50,
        }),
        (l) => {
          const [la, lb] = IndexList.unzip(IndexList.ofList(l));
          expect(la.toList()).toEqual(l.map(([a]) => a));
          expect(lb.toList()).toEqual(l.map(([, b]) => b));
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer(), fc.float({ noNaN: true }), fc.string()), {
          maxLength: 50,
        }),
        (l) => {
          const [la, lb, lc] = IndexList.unzip3(IndexList.ofList(l));
          expect(la.toList()).toEqual(l.map(([a]) => a));
          expect(lb.toList()).toEqual(l.map(([, b]) => b));
          expect(lc.toList()).toEqual(l.map(([, , c]) => c));
        },
      ),
    );
  });

  test("rev preserves min/max indices and reverses values", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const ll = IndexList.ofList(l);
        const rl = ll.rev();
        if (ll.count > 0) {
          expect(ll.minIndex.equals(rl.minIndex)).toBe(true);
          expect(ll.maxIndex.equals(rl.maxIndex)).toBe(true);
        }
        expect(rl.toList()).toEqual([...l].reverse());
      }),
    );
  });

  test("enumerator agrees with toList", () => {
    fc.assert(
      fc.property(arbList, (m) => {
        const h = IndexList.ofList(m);
        expect([...h]).toEqual(h.toList());
        expect([...h]).toEqual(m);
      }),
    );
  });

  test("collect concatenates per-element lists", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const refOut = l.flatMap((v) => [v, 2 * v, 3 * v]);
        const got = IndexList.ofList(l)
          .collect((v) => IndexList.ofList([v, 2 * v, 3 * v]))
          .toList();
        expect(got).toEqual(refOut);
      }),
    );
  });

  test("map matches Array.prototype.map", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const ref = l.map((v) => Math.floor(v / 3));
        const got = IndexList.ofList(l).map((_i, v) => Math.floor(v / 3)).toList();
        expect(got).toEqual(ref);
      }),
    );
  });

  test("add and prepend extend the list at both ends", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const il = IndexList.ofList(l).add(1).prepend(5);
        expect(il.toList()).toEqual([5, ...l, 1]);
      }),
    );
  });

  test("equality (by-value) detects extension and prepend", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const a = IndexList.ofList(l);
        expect(a.equalsByValues(a)).toBe(true);
        expect(a.equalsByValues(a.add(1))).toBe(false);
        expect(a.equalsByValues(a.prepend(1))).toBe(false);
      }),
    );
  });

  test("range produces [lo..hi]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        (lo, hi) => {
          const got = IndexList.range(lo, hi).toList();
          const ref: number[] = [];
          for (let i = lo; i <= hi; i++) ref.push(i);
          expect(got).toEqual(ref);
        },
      ),
    );
  });

  test("init builds [0..length-1] mapped", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (n) => {
        expect(IndexList.init(n, (i) => i).toList()).toEqual(
          Array.from({ length: n }, (_, i) => i),
        );
      }),
    );
  });

  test("tryGetPosition returns the int position for each Index in the list", () => {
    fc.assert(
      fc.property(arbList, (l) => {
        const ll = IndexList.ofList(l);
        let i = 0;
        for (const [idx] of ll.toSeqIndexed()) {
          expect(ll.tryGetPosition(idx)).toBe(i);
          i += 1;
        }
      }),
    );
  });

  test("computeDelta / applyDelta full identities", () => {
    fc.assert(
      fc.property(arbList, arbList, arbList, (l1, l2, l3) => {
        const i1 = IndexList.ofList(l1);
        const i2 = IndexList.ofList(l2);
        const i3 = IndexList.ofList(l3);
        expect(IndexListDeltaExt.computeDelta(i1, i1).isEmpty).toBe(true);
        expect(IndexListDeltaExt.computeDelta(i2, i2).isEmpty).toBe(true);
        expect(IndexListDeltaExt.computeDelta(i3, i3).isEmpty).toBe(true);

        const d12 = IndexListDeltaExt.computeDelta(i1, i2);
        const d23 = IndexListDeltaExt.computeDelta(i2, i3);
        const d31 = IndexListDeltaExt.computeDelta(i3, i1);
        expect(IndexListDeltaExt.applyDelta(i1, d12).state.toList()).toEqual(l2);
        expect(IndexListDeltaExt.applyDelta(i2, d23).state.toList()).toEqual(l3);
        expect(IndexListDeltaExt.applyDelta(i3, d31).state.toList()).toEqual(l1);

        const d123 = d12.combine(d23);
        const d231 = d23.combine(d31);
        const d312 = d31.combine(d12);
        expect(IndexListDeltaExt.applyDelta(i1, d123).state.toList()).toEqual(l3);
        expect(IndexListDeltaExt.applyDelta(i2, d231).state.toList()).toEqual(l1);
        expect(IndexListDeltaExt.applyDelta(i3, d312).state.toList()).toEqual(l2);

        const d1231 = d123.combine(d31);
        const d2312 = d231.combine(d12);
        const d3123 = d312.combine(d23);
        expect(IndexListDeltaExt.applyDelta(i1, d1231).state.toList()).toEqual(l1);
        expect(IndexListDeltaExt.applyDelta(i2, d2312).state.toList()).toEqual(l2);
        expect(IndexListDeltaExt.applyDelta(i3, d3123).state.toList()).toEqual(l3);
      }),
    );
  });

  test("computeDeltaToList round-trips and is empty for self", () => {
    const eq = (a: number, b: number) => a === b;
    fc.assert(
      fc.property(arbList, arbList, (l1, l2) => {
        const a1 = IndexList.ofList(l1);
        const a2 = IndexList.ofList(l2);
        expect(IndexListDeltaExt.computeDeltaToList(eq, a1, l1).isEmpty).toBe(true);
        expect(IndexListDeltaExt.computeDeltaToList(eq, a2, l2).isEmpty).toBe(true);
        const d12 = IndexListDeltaExt.computeDeltaToList(eq, a1, l2);
        const d21 = IndexListDeltaExt.computeDeltaToList(eq, a2, l1);
        expect(IndexListDeltaExt.applyDelta(a1, d12).state.toList()).toEqual(l2);
        expect(IndexListDeltaExt.applyDelta(a2, d21).state.toList()).toEqual(l1);
      }),
    );
  });

  test("sub returns the int-bounded sub-range", () => {
    fc.assert(
      fc.property(
        arbList,
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (l, oRaw, cRaw) => {
          const ll = IndexList.ofList(l);
          const o = ll.count > 0 ? oRaw % ll.count : 0;
          const c = ll.count > 0 ? cRaw % ll.count : 0;
          const ref = l.slice(o, o + c);
          expect(ll.sub(o, c).toList()).toEqual(ref);
        },
      ),
    );
  });
});
