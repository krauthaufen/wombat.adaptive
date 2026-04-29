// Port of FSharp.Data.Adaptive Datastructures/IndexListDelta.fs +
// the IndexList entries from Deltas.fs.

import { Index, IndexOps, indexZero } from "./index.js";
import { IndexList } from "./indexList.js";
import { MapExt, type KeyComparer } from "./mapExt.js";
import {
  ElementRemove,
  ElementSet,
  type ElementOperation,
} from "./operations.js";

const indexCmp: KeyComparer<Index> = (a, b) => a.compareTo(b);

/**
 * A delta against an `IndexList<T>`: a sorted map from `Index` to
 * `ElementOperation<T>`.
 */
export class IndexListDelta<T>
  implements Iterable<[Index, ElementOperation<T>]>
{
  private readonly _content: MapExt<Index, ElementOperation<T>>;

  /** @internal */
  constructor(content: MapExt<Index, ElementOperation<T>>) {
    this._content = content;
  }

  get content(): MapExt<Index, ElementOperation<T>> {
    return this._content;
  }
  get count(): number {
    return this._content.count;
  }
  get isEmpty(): boolean {
    return this._content.isEmpty;
  }

  static empty<T>(): IndexListDelta<T> {
    return new IndexListDelta<T>(MapExt.empty<Index, ElementOperation<T>>(indexCmp));
  }

  add(idx: Index, op: ElementOperation<T>): IndexListDelta<T> {
    return new IndexListDelta<T>(this._content.add(idx, op));
  }

  combine(other: IndexListDelta<T>): IndexListDelta<T> {
    return new IndexListDelta<T>(this._content.union(other._content));
  }

  static ofSeq<T>(
    s: Iterable<[Index, ElementOperation<T>]>,
  ): IndexListDelta<T> {
    return new IndexListDelta<T>(MapExt.ofSeq(s, indexCmp));
  }
  static ofArray<T>(
    s: Array<[Index, ElementOperation<T>]>,
  ): IndexListDelta<T> {
    return IndexListDelta.ofSeq(s);
  }
  static ofList<T>(
    s: Array<[Index, ElementOperation<T>]>,
  ): IndexListDelta<T> {
    return IndexListDelta.ofSeq(s);
  }
  static ofMap<T>(
    m: MapExt<Index, ElementOperation<T>>,
  ): IndexListDelta<T> {
    return new IndexListDelta<T>(m);
  }

  toSeq(): Iterable<[Index, ElementOperation<T>]> {
    return this;
  }
  toList(): Array<[Index, ElementOperation<T>]> {
    return this._content.toList();
  }
  toArray(): Array<[Index, ElementOperation<T>]> {
    return this._content.toArray();
  }
  toMap(): MapExt<Index, ElementOperation<T>> {
    return this._content;
  }

  *[Symbol.iterator](): IterableIterator<[Index, ElementOperation<T>]> {
    for (const e of this._content) yield e;
  }

  equals(other: IndexListDelta<T>): boolean {
    if (this._content.count !== other._content.count) return false;
    for (const [k, op] of this._content) {
      const o = other._content.tryFind(k);
      if (o === undefined && !other._content.containsKey(k)) return false;
      if (op.tag !== o!.tag) return false;
      if (op.tag === "Set" && o!.tag === "Set") {
        if (!Object.is(op.value, o!.value)) return false;
      }
    }
    return true;
  }
}

export const IndexListDeltaOps = {
  empty: <T>() => IndexListDelta.empty<T>(),
  add: <T>(idx: Index, op: ElementOperation<T>, d: IndexListDelta<T>) =>
    d.add(idx, op),
  combine: <T>(a: IndexListDelta<T>, b: IndexListDelta<T>) => a.combine(b),
  ofSeq: <T>(s: Iterable<[Index, ElementOperation<T>]>) => IndexListDelta.ofSeq(s),
  ofList: <T>(s: Array<[Index, ElementOperation<T>]>) => IndexListDelta.ofList(s),
  ofArray: <T>(s: Array<[Index, ElementOperation<T>]>) => IndexListDelta.ofArray(s),
  ofMap: <T>(m: MapExt<Index, ElementOperation<T>>) => IndexListDelta.ofMap(m),
  toSeq: <T>(d: IndexListDelta<T>) => d.toSeq(),
  toList: <T>(d: IndexListDelta<T>) => d.toList(),
  toArray: <T>(d: IndexListDelta<T>) => d.toArray(),
  toMap: <T>(d: IndexListDelta<T>) => d.toMap(),
  isEmpty: <T>(d: IndexListDelta<T>) => d.isEmpty,
  count: <T>(d: IndexListDelta<T>) => d.count,
};

// ---------------------------------------------------------------------------
// Deltas.fs IndexList entries
// ---------------------------------------------------------------------------

export const IndexListDeltaExt = {
  /**
   * Apply a delta to a list. Returns the new list and the effective
   * operations.
   */
  applyDelta: <T>(
    x: IndexList<T>,
    deltas: IndexListDelta<T>,
  ): { state: IndexList<T>; delta: IndexListDelta<T> } => {
    const apply = (
      _k: Index,
      existing: T | undefined,
      n: ElementOperation<T>,
    ): [T | undefined, ElementOperation<T> | undefined] => {
      if (n.tag === "Remove") {
        if (existing !== undefined) return [undefined, ElementRemove];
        return [undefined, undefined];
      }
      // Set
      if (existing !== undefined) {
        if (Object.is(existing, n.value)) return [n.value, undefined];
        return [n.value, ElementSet(n.value)];
      }
      return [n.value, ElementSet(n.value)];
    };
    const result = x.content.applyDeltaAndGetEffective<
      ElementOperation<T>,
      ElementOperation<T>
    >(deltas.content, apply);
    return {
      state: IndexList.fromMap(result.state),
      delta: IndexListDelta.ofMap(result.effective),
    };
  },

  /**
   * Determine the operations needed to transform `l` into `r`, with
   * custom add/remove/update callbacks.
   */
  computeDeltaCustom: <T>(
    add: (idx: Index, v: T) => ElementOperation<T>,
    remove: (idx: Index, v: T) => ElementOperation<T>,
    update: (idx: Index, oldV: T, newV: T) => ElementOperation<T> | undefined,
    l: IndexList<T>,
    r: IndexList<T>,
  ): IndexListDelta<T> => {
    const res = l.content.computeDeltaTo<ElementOperation<T>>(
      r.content,
      add,
      update,
      remove,
    );
    return IndexListDelta.ofMap(res);
  },

  /** Default computeDelta — Set on add/update, Remove on delete. */
  computeDelta: <T>(
    l: IndexList<T>,
    r: IndexList<T>,
  ): IndexListDelta<T> => {
    return IndexListDeltaExt.computeDeltaCustom<T>(
      (_k, v) => ElementSet(v),
      (_k, _v) => ElementRemove,
      (_k, ov, nv) => (Object.is(ov, nv) ? undefined : ElementSet(nv)),
      l,
      r,
    );
  },

  /**
   * Determines the operations needed to transform `src` into the
   * given `dst` array, treating elements by user-supplied equality.
   * Uses the Myers diff algorithm so the returned delta is "minimal"
   * in edit-distance terms, reusing source Indices wherever possible.
   */
  computeDeltaToArray: <T>(
    equals: (a: T, b: T) => boolean,
    src: IndexList<T>,
    dst: T[],
  ): IndexListDelta<T> => {
    if (dst.length === 0) {
      return IndexListDeltaExt.computeDelta(src, IndexList.empty<T>());
    }
    if (src.count === 0) {
      return IndexListDeltaExt.computeDelta(src, IndexList.ofArray(dst));
    }
    // Both non-empty: run Myers, then translate Add/Remove/Equal ops
    // into IndexListDelta operations using the source Indices.
    const srcArr = src.toArrayIndexed();
    const ops = myersDiff(equals, srcArr, dst);
    let si = 0;
    let di = 0;
    let delta = IndexListDelta.empty<T>();
    let lastIndex = indexZero;
    let i = 0;
    while (i < ops.length) {
      const op = ops[i]!;
      if (op === DeltaOp.Equal) {
        lastIndex = srcArr[si]![0];
        si += 1;
        di += 1;
        i += 1;
        continue;
      }
      // Collect a run of non-Equal ops (Add/Remove) until the next Equal.
      let remCnt = 0;
      let addCnt = 0;
      while (i < ops.length && ops[i]! !== DeltaOp.Equal) {
        if (ops[i]! === DeltaOp.Remove) remCnt += 1;
        else addCnt += 1;
        i += 1;
      }
      const replace = Math.min(remCnt, addCnt);
      for (let r = 0; r < replace; r++) {
        const idx = srcArr[si]![0];
        delta = delta.add(idx, ElementSet(dst[di]!));
        si += 1;
        di += 1;
        lastIndex = idx;
      }
      for (let r = replace; r < remCnt; r++) {
        const idx = srcArr[si]![0];
        delta = delta.add(idx, ElementRemove);
        si += 1;
      }
      if (replace < addCnt) {
        const useBetween = si < srcArr.length;
        const next = useBetween ? srcArr[si]![0] : null;
        for (let r = replace; r < addCnt; r++) {
          const newIdx =
            next !== null
              ? IndexOps.between(lastIndex, next)
              : IndexOps.after(lastIndex);
          delta = delta.add(newIdx, ElementSet(dst[di]!));
          lastIndex = newIdx;
          di += 1;
        }
      }
    }
    return delta;
  },

  /**
   * Same as `computeDeltaToArray` but returns the rebuilt IndexList
   * alongside the delta.
   */
  computeDeltaToArrayAndGetResult: <T>(
    equals: (a: T, b: T) => boolean,
    src: IndexList<T>,
    dst: T[],
  ): { delta: IndexListDelta<T>; result: IndexList<T> } => {
    const delta = IndexListDeltaExt.computeDeltaToArray(equals, src, dst);
    const { state } = IndexListDeltaExt.applyDelta(src, delta);
    return { delta, result: state };
  },

  /** Convenience over `computeDeltaToArray` for an iterable / list. */
  computeDeltaToList: <T>(
    equals: (a: T, b: T) => boolean,
    src: IndexList<T>,
    dst: T[],
  ): IndexListDelta<T> => IndexListDeltaExt.computeDeltaToArray(equals, src, dst),

  computeDeltaToSeq: <T>(
    equals: (a: T, b: T) => boolean,
    src: IndexList<T>,
    dst: Iterable<T>,
  ): IndexListDelta<T> =>
    IndexListDeltaExt.computeDeltaToArray(equals, src, [...dst]),
};

// ---------------------------------------------------------------------------
// Myers diff
//
// PORT NOTE: F# packs the operation list into 64-bit chunks
// (`DeltaOperationList64`) for cache efficiency and represents it as a
// linked list of those chunks. We use a plain `DeltaOp[]` here — the
// total ops count is bounded by `src.length + dst.length`, well under
// any size where the F# packing matters in JS.
// ---------------------------------------------------------------------------

const enum DeltaOp {
  Remove = 0,
  Add = 1,
  Equal = 2,
}

/**
 * Standard Myers algorithm. Returns operations in source-and-target
 * order: Remove pops from `src`, Add takes from `dst`, Equal advances
 * both. F# original additionally reverses the inputs to walk
 * backwards; we keep the natural orientation.
 */
function myersDiff<A, B>(
  equals: (a: A, b: B) => boolean,
  src: ReadonlyArray<readonly [unknown, A]>,
  dst: ReadonlyArray<B>,
): DeltaOp[] {
  const m = src.length;
  const n = dst.length;
  const max = m + n;
  const v = new Array<number>(2 * max + 1).fill(0);
  const trace: number[][] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[k - 1 + max] ?? 0) < (v[k + 1 + max] ?? 0))) {
        x = v[k + 1 + max] ?? 0;
      } else {
        x = (v[k - 1 + max] ?? 0) + 1;
      }
      let y = x - k;
      while (x < m && y < n && equals(src[x]![1], dst[y]!)) {
        x += 1;
        y += 1;
      }
      v[k + max] = x;
      if (x >= m && y >= n) {
        // Reconstruct path by walking the trace back.
        return reconstructPath(trace, d, x, y, max);
      }
    }
  }
  return [];
}

function reconstructPath(
  trace: number[][],
  finalD: number,
  endX: number,
  endY: number,
  max: number,
): DeltaOp[] {
  const ops: DeltaOp[] = [];
  let x = endX;
  let y = endY;
  for (let d = finalD; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v[k - 1 + max] ?? 0) < (v[k + 1 + max] ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[prevK + max] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(DeltaOp.Equal);
      x -= 1;
      y -= 1;
    }
    if (x === prevX) ops.push(DeltaOp.Add);
    else ops.push(DeltaOp.Remove);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push(DeltaOp.Equal);
    x -= 1;
    y -= 1;
  }
  ops.reverse();
  return ops;
}
