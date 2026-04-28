// Tests for Index, MapExt, IndexList, IndexListDelta. Subset of the F#
// IndexList tests in FSharp.Data.Adaptive.Tests/IndexList.fs.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Index, IndexOps, indexZero } from "../src/datastructures/index.js";
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
