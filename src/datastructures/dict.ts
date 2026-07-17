// Dict<K, V> — mutable hash table honouring the `equals(other)` /
// `getHashCode()` convention from `equality.ts`, laid out like
// .NET's `Dictionary<TKey, TValue>`:
//
//   _buckets : Int32Array   hash-bucket heads (entry index + 1; 0 = empty)
//   _hashes  : Int32Array   per-entry cached hash (-1 = free slot)
//   _next    : Int32Array   per-entry collision / freelist chain
//   _keys    : K[]          per-entry key
//   _values  : V[]          per-entry value
//
// Why not the existing `HashTable` (Map<hash, [K,V][]>): that costs a
// JS-Map entry + a bucket array + a tuple per pair (~130 B) and its
// API forces double probes (`get` then `set`). This layout is two
// typed-array slots + two elements-array slots per entry (~45 B), the
// cached hash makes resize a pointer shuffle (keys are never
// re-hashed), and the API is single-probe throughout:
//
//   tryGet(k)            one probe
//   getOrAdd(k, factory) one probe, factory only on miss
//   alter(k, f)          one probe; f(old | undefined) → new | undefined
//                        (undefined deletes) — the .NET
//                        `CollectionsMarshal.GetValueRefOrAddDefault`
//                        pattern for counters / upserts
//   remove(k)            one probe, returns the removed value
//
// NEVER `if (has(k)) get(k)` — that is the pattern this type exists
// to kill.
//
// Iteration order is insertion order (holes skipped), matching
// `Map`'s ergonomics closely enough for internal-cache use. This is a
// MUTABLE structure for reader-internal caches and accumulators —
// anything exposed as adaptive STATE (History versions, reader
// `.state`) stays on the persistent `HashMap`/`CountingHashSet`.

import { defaultEquals, defaultHash } from "./equality.js";

const FREE = -1;

export class Dict<K, V> implements Iterable<[K, V]> {
  private _buckets: Int32Array;
  private _hashes: Int32Array;
  private _next: Int32Array;
  private _keys: (K | undefined)[];
  private _values: (V | undefined)[];
  /** High-water mark of used entry slots. */
  private _touched = 0;
  /** Head of the freelist (index) or -1. */
  private _freeList = -1;
  private _freeCount = 0;
  /** _buckets.length - 1 (power-of-two capacity). */
  private _mask: number;

  constructor(initialCapacity = 8) {
    let cap = 8;
    while (cap < initialCapacity) cap <<= 1;
    this._buckets = new Int32Array(cap);
    this._hashes = new Int32Array(cap);
    this._next = new Int32Array(cap);
    this._keys = new Array<K | undefined>(cap);
    this._values = new Array<V | undefined>(cap);
    this._mask = cap - 1;
  }

  get count(): number {
    return this._touched - this._freeCount;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  private grow(): void {
    const oldCap = this._buckets.length;
    const cap = oldCap << 1;
    const buckets = new Int32Array(cap);
    const hashes = new Int32Array(cap);
    const next = new Int32Array(cap);
    hashes.set(this._hashes);
    const mask = cap - 1;
    // Re-seat every live entry using the CACHED hash — keys are not
    // re-hashed on resize.
    for (let i = 0; i < this._touched; i++) {
      if (this._hashes[i] === FREE && this._keys[i] === undefined) {
        // freelist slot — keep its chain via _next below
        next[i] = this._next[i]!;
        hashes[i] = FREE;
        continue;
      }
      const b = (this._hashes[i]! & 0x7fffffff) & mask;
      next[i] = buckets[b]! - 1;
      buckets[b] = i + 1;
    }
    this._buckets = buckets;
    this._hashes = hashes;
    this._next = next;
    this._keys.length = cap;
    this._values.length = cap;
    this._mask = mask;
  }

  /** Index of `k`'s entry, or -1. Single probe. */
  private find(k: K, hash: number): number {
    let i = this._buckets[hash & this._mask]! - 1;
    while (i >= 0) {
      if (this._hashes[i] === hash && defaultEquals(this._keys[i], k)) return i;
      i = this._next[i]!;
    }
    return -1;
  }

  /** Allocate an entry slot (freelist first), link into its bucket. */
  private addSlot(k: K, v: V, hash: number): void {
    let i: number;
    if (this._freeCount > 0) {
      i = this._freeList;
      this._freeList = this._next[i]!;
      this._freeCount--;
    } else {
      if (this._touched === this._buckets.length) this.grow();
      i = this._touched++;
    }
    const b = hash & this._mask;
    this._hashes[i] = hash;
    this._next[i] = this._buckets[b]! - 1;
    this._keys[i] = k;
    this._values[i] = v;
    this._buckets[b] = i + 1;
  }

  private unlink(k: K, hash: number): number {
    const b = hash & this._mask;
    let i = this._buckets[b]! - 1;
    let prev = -1;
    while (i >= 0) {
      if (this._hashes[i] === hash && defaultEquals(this._keys[i], k)) {
        const nx = this._next[i]!;
        if (prev < 0) this._buckets[b] = nx + 1;
        else this._next[prev] = nx;
        return i;
      }
      prev = i;
      i = this._next[i]!;
    }
    return -1;
  }

  private freeSlot(i: number): void {
    this._hashes[i] = FREE;
    this._keys[i] = undefined;
    this._values[i] = undefined;
    this._next[i] = this._freeList;
    this._freeList = i;
    this._freeCount++;
  }

  /** The value for `k`, or `undefined`. One probe. */
  tryGet(k: K): V | undefined {
    const i = this.find(k, defaultHash(k) | 0);
    return i < 0 ? undefined : (this._values[i] as V);
  }

  has(k: K): boolean {
    return this.find(k, defaultHash(k) | 0) >= 0;
  }

  /** Insert or replace. One probe (plus the insert). */
  set(k: K, v: V): this {
    const hash = defaultHash(k) | 0;
    const i = this.find(k, hash);
    if (i >= 0) this._values[i] = v;
    else this.addSlot(k, v, hash);
    return this;
  }

  /** The value for `k`, creating it via `factory` on miss. One probe. */
  getOrAdd(k: K, factory: (k: K) => V): V {
    const hash = defaultHash(k) | 0;
    const i = this.find(k, hash);
    if (i >= 0) return this._values[i] as V;
    const v = factory(k);
    this.addSlot(k, v, hash);
    return v;
  }

  /**
   * Upsert/delete in one probe: `f` receives the current value (or
   * `undefined`) and returns the new value — `undefined` removes the
   * entry. The single-probe replacement for every
   * `if (has(k)) … get(k) … set(k)` counter/accumulator pattern.
   */
  alter(k: K, f: (v: V | undefined) => V | undefined): void {
    const hash = defaultHash(k) | 0;
    const i = this.find(k, hash);
    if (i >= 0) {
      const nv = f(this._values[i] as V);
      if (nv === undefined) {
        this.unlinkAt(k, hash, i);
      } else {
        this._values[i] = nv;
      }
    } else {
      const nv = f(undefined);
      if (nv !== undefined) this.addSlot(k, nv, hash);
    }
  }

  /** Unlink when the entry index is already known (post-find). */
  private unlinkAt(k: K, hash: number, _i: number): void {
    const i = this.unlink(k, hash);
    // find() succeeded, so unlink() must too.
    this.freeSlot(i);
  }

  /** Remove `k`. Returns the removed value or `undefined`. One probe. */
  remove(k: K): V | undefined {
    const hash = defaultHash(k) | 0;
    const i = this.unlink(k, hash);
    if (i < 0) return undefined;
    const v = this._values[i] as V;
    this.freeSlot(i);
    return v;
  }

  clear(): void {
    this._buckets.fill(0);
    this._hashes.fill(0);
    this._next.fill(0);
    this._keys.length = 0;
    this._keys.length = this._buckets.length;
    this._values.length = 0;
    this._values.length = this._buckets.length;
    this._touched = 0;
    this._freeList = -1;
    this._freeCount = 0;
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (let i = 0; i < this._touched; i++) {
      if (this._hashes[i] === FREE && this._keys[i] === undefined) continue;
      yield [this._keys[i] as K, this._values[i] as V];
    }
  }

  *keys(): IterableIterator<K> {
    for (const [k] of this) yield k;
  }

  *values(): IterableIterator<V> {
    for (let i = 0; i < this._touched; i++) {
      if (this._hashes[i] === FREE && this._keys[i] === undefined) continue;
      yield this._values[i] as V;
    }
  }

  forEach(f: (v: V, k: K) => void): void {
    for (let i = 0; i < this._touched; i++) {
      if (this._hashes[i] === FREE && this._keys[i] === undefined) continue;
      f(this._values[i] as V, this._keys[i] as K);
    }
  }
}
