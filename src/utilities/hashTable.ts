// Mutable HashTable<K, V> honouring the `equals(other)` /
// `getHashCode()` convention from `equality.ts`.
//
// Use cases: per-reader caches, MultiSetMap-style accumulators, and
// anywhere F# would have used `Dictionary<'K, _>`. Faster than the
// persistent `HashMap` for hot-path mutation because there is no
// path-copy on insert/remove.
//
// Since the Dict rework this is a thin façade over the internal
// .NET-Dictionary-layout `Dict` (Int32Array buckets/chains + parallel
// key/value stores, cached hashes, single-probe ops) — the previous
// Map<hash, [K,V][]> layout cost ~3× the bytes per entry. The public
// API is unchanged.

import { Dict } from "../datastructures/dict.js";

export class HashTable<K, V> implements Iterable<[K, V]> {
  private readonly _d: Dict<K, V> = new Dict();

  get size(): number {
    return this._d.count;
  }

  /** Number of entries currently in the table. */
  get count(): number {
    return this._d.count;
  }

  /** True iff the table has no entries. */
  get isEmpty(): boolean {
    return this._d.isEmpty;
  }

  /** Returns the value associated with `k`, or `undefined`. */
  get(k: K): V | undefined {
    return this._d.tryGet(k);
  }

  /** Returns whether the table contains an entry for `k`. */
  has(k: K): boolean {
    return this._d.has(k);
  }

  /** Inserts or replaces the entry for `k`. */
  set(k: K, v: V): this {
    this._d.set(k, v);
    return this;
  }

  /** Removes the entry for `k`, if any. Returns whether it was present. */
  delete(k: K): boolean {
    return this._d.remove(k) !== undefined;
  }

  /** Removes all entries. */
  clear(): void {
    this._d.clear();
  }

  /** Iterate over all `[key, value]` pairs. */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this._d[Symbol.iterator]();
  }

  keys(): IterableIterator<K> {
    return this._d.keys();
  }
  values(): IterableIterator<V> {
    return this._d.values();
  }
}
