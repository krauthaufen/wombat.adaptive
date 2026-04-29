// Mutable open-chaining HashTable<K, V> honouring the
// `equals(other)` / `getHashCode()` convention from `equality.ts`.
//
// Use cases: per-reader Caches, MultiSetMap-style accumulators, and
// anywhere F# would have used `Dictionary<'K, _>`. Faster than the
// persistent `HashMap` for hot-path mutation because there is no
// path-copy on insert/remove.
//
// Bucket layout: a JS `Map<number, Bucket<K, V>>` keyed by the
// 32-bit hash code. Each bucket is a flat array of (key, value)
// pairs. For hash codes with no collision (the common case for
// primitives and identity-hashed objects) the bucket holds exactly
// one entry, so lookups cost one Map-get + one array index +
// one equality check.

import { defaultEquals, defaultHash } from "../datastructures/equality.js";

/** @internal */
type Bucket<K, V> = Array<[K, V]>;

export class HashTable<K, V> implements Iterable<[K, V]> {
  private readonly _buckets: Map<number, Bucket<K, V>> = new Map();
  private _size = 0;

  get size(): number {
    return this._size;
  }

  /** Number of entries currently in the table. */
  get count(): number {
    return this._size;
  }

  /** True iff the table has no entries. */
  get isEmpty(): boolean {
    return this._size === 0;
  }

  /**
   * Internal: locate the index in the hash-code's bucket where `k`
   * lives, or -1 if not present. Returns the bucket and index so the
   * caller can mutate without re-hashing.
   */
  private locate(k: K): { bucket: Bucket<K, V>; index: number; hash: number } {
    const hash = defaultHash(k) | 0;
    const bucket = this._buckets.get(hash);
    if (bucket === undefined) return { bucket: [], index: -1, hash };
    for (let i = 0; i < bucket.length; i++) {
      if (defaultEquals(bucket[i]![0], k)) return { bucket, index: i, hash };
    }
    return { bucket, index: -1, hash };
  }

  /** Returns the value associated with `k`, or `undefined`. */
  get(k: K): V | undefined {
    const r = this.locate(k);
    if (r.index < 0) return undefined;
    return r.bucket[r.index]![1];
  }

  /** Returns whether the table contains an entry for `k`. */
  has(k: K): boolean {
    return this.locate(k).index >= 0;
  }

  /** Inserts or replaces the entry for `k`. */
  set(k: K, v: V): this {
    const r = this.locate(k);
    if (r.index >= 0) {
      r.bucket[r.index] = [k, v];
      return this;
    }
    if (r.bucket.length === 0) {
      this._buckets.set(r.hash, [[k, v]]);
    } else {
      r.bucket.push([k, v]);
    }
    this._size += 1;
    return this;
  }

  /** Removes the entry for `k`, if any. Returns whether it was present. */
  delete(k: K): boolean {
    const r = this.locate(k);
    if (r.index < 0) return false;
    if (r.bucket.length === 1) this._buckets.delete(r.hash);
    else r.bucket.splice(r.index, 1);
    this._size -= 1;
    return true;
  }

  /** Removes all entries. */
  clear(): void {
    this._buckets.clear();
    this._size = 0;
  }

  /** Iterate over all `[key, value]` pairs. */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const bucket of this._buckets.values()) {
      for (const kv of bucket) yield kv;
    }
  }

  *keys(): IterableIterator<K> {
    for (const [k] of this) yield k;
  }
  *values(): IterableIterator<V> {
    for (const [, v] of this) yield v;
  }
}
