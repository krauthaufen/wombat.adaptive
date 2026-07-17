// Port of FSharp.Data.Adaptive Utilities/Cache.fs
//
// PORT NOTE: F# original uses `Dictionary<T1, _>` with the runtime
// default equality comparer. The TS port is backed by the internal
// `Dict` (see `datastructures/dict.ts`) which honours the
// `equals(other)` / `getHashCode()` convention from `equality.ts`
// with .NET-Dictionary layout (Int32Array buckets/chains + parallel
// stores) — no per-entry tuple/bucket objects, and every operation is
// a single probe: `invoke` rides `getOrAdd` with ONE factory closure
// allocated per Cache (never per call), revokes mutate the entry
// in place and only touch the table again for the refcount-0 removal.

import { Dict } from "../datastructures/dict.js";

interface Entry<T2> {
  value: T2;
  refCount: number;
}

/**
 * Cache represents a cached function which can be invoked and revoked.
 * Invoke increments the reference count for a specific argument
 * (possibly causing the function to be executed) whereas revoke
 * decreases the reference count and removes the cache entry whenever
 * the reference count is 0.
 */
export class Cache<T1, T2> {
  private readonly _mapping: (v: T1) => T2;
  private readonly _cache: Dict<T1, Entry<T2>> = new Dict();
  /** Shared getOrAdd factory — starts at refCount 0; `invoke` bumps
   *  unconditionally, so a fresh entry ends up at 1 like a hit. */
  private readonly _newEntry = (v: T1): Entry<T2> => ({
    value: this._mapping(v),
    refCount: 0,
  });

  constructor(mapping: (v: T1) => T2) {
    this._mapping = mapping;
  }

  /**
   * Removes all entries from the Cache and executes a function for
   * all removed cache entries.
   */
  clear(remove: (v: T2) => void): void {
    for (const e of this._cache.values()) remove(e.value);
    this._cache.clear();
  }

  /**
   * Returns the function value associated with the given argument
   * (possibly executing the function) and increases the associated
   * reference count.
   */
  invoke(v: T1): T2 {
    const e = this._cache.getOrAdd(v, this._newEntry);
    e.refCount += 1;
    return e.value;
  }

  revokeAndGetDeletedUnsafe(v: T1): { deleted: boolean; value: T2 } {
    const existing = this._cache.tryGet(v);
    if (existing === undefined) {
      throw new Error(`cannot revoke unknown value: ${String(v)}`);
    }
    existing.refCount -= 1;
    if (existing.refCount === 0) {
      this._cache.remove(v);
      return { deleted: true, value: existing.value };
    }
    return { deleted: false, value: existing.value };
  }

  tryRevokeAndGetDeleted(
    v: T1,
  ): { deleted: boolean; value: T2 } | undefined {
    const existing = this._cache.tryGet(v);
    if (existing === undefined) return undefined;
    existing.refCount -= 1;
    if (existing.refCount === 0) {
      this._cache.remove(v);
      return { deleted: true, value: existing.value };
    }
    return { deleted: false, value: existing.value };
  }

  revokeUnsafe(v: T1): T2 {
    return this.revokeAndGetDeletedUnsafe(v).value;
  }

  tryRevoke(v: T1): T2 | undefined {
    const existing = this._cache.tryGet(v);
    if (existing === undefined) return undefined;
    existing.refCount -= 1;
    if (existing.refCount === 0) this._cache.remove(v);
    return existing.value;
  }

  /** Enumerate over all cache values. */
  *values(): IterableIterator<T2> {
    for (const e of this._cache.values()) yield e.value;
  }
}
