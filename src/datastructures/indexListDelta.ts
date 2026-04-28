// Port of FSharp.Data.Adaptive Datastructures/IndexListDelta.fs +
// the IndexList entries from Deltas.fs.

import { Index } from "./index.js";
import { IndexList } from "./indexList.js";
import { MapExt, type KeyComparer } from "./mapExt.js";
import {
  ElementRemove,
  ElementSet,
  type ElementOperation,
} from "./operations.js";

const indexCmp: KeyComparer<Index> = (a, b) => a.compareTo(b);

/// A delta against an `IndexList<T>`: a sorted map from `Index` to
/// `ElementOperation<T>`.
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
  /// Apply a delta to a list. Returns the new list and the effective
  /// operations.
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

  /// Determine the operations needed to transform `l` into `r`, with
  /// custom add/remove/update callbacks.
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

  /// Default computeDelta — Set on add/update, Remove on delete.
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
};
