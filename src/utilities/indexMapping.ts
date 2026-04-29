// Translates structurally-comparable keys into a stable ordering on
// fresh `Index` values, matching F#'s `IndexMapping<'k>`
// (Utilities.fs).
//
// The internal store is a sorted `MapExt<K, Index>`. On `invoke(k)`
// we either return an already-assigned `Index` or generate a fresh
// one between the existing neighbours, preserving the comparison
// order of `K` in the resulting `Index` ordering.

import { MapExt } from "../datastructures/mapExt.js";
import {
  type Index,
  indexZero,
} from "../datastructures/index.js";

/** Comparator function: negative / 0 / positive like `Array.sort`. */
export type Compare<K> = (a: K, b: K) => number;

export class IndexMapping<K> {
  private readonly _cmp: Compare<K>;
  private _store: MapExt<K, Index>;

  constructor(cmp: Compare<K>) {
    this._cmp = cmp;
    this._store = MapExt.empty<K, Index>(cmp);
  }

  /**
   * Returns the `Index` associated with `k`. If `k` is new, a fresh
   * `Index` is generated such that the order of `Index` values
   * matches the order of `K`.
   */
  invoke(k: K): Index {
    let result: Index | undefined;
    this._store = this._store.changeWithNeighbours(k, (left, self, right) => {
      if (self !== undefined) {
        result = self;
        return self;
      }
      let idx: Index;
      if (left === undefined && right === undefined) idx = indexZero.after();
      else if (left !== undefined && right === undefined) idx = left[1].after();
      else if (left === undefined && right !== undefined) idx = right[1].before();
      else idx = (left as [K, Index])[1].between((right as [K, Index])[1]);
      result = idx;
      return idx;
    });
    return result as Index;
  }

  /** Removes the entry for `k`, returning the index it occupied (if any). */
  revoke(k: K): Index | undefined {
    const existing = this._store.tryFind(k);
    if (existing === undefined) return undefined;
    this._store = this._store.remove(k);
    return existing;
  }

  clear(): void {
    this._store = MapExt.empty<K, Index>(this._cmp);
  }

  get size(): number {
    return this._store.count;
  }
}
