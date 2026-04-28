// Port of FSharp.Data.Adaptive Datastructures/MapExt.fs
//
// =============================================================================
// PORT NOTE — IMPLEMENTATION CHOICE
// =============================================================================
//
// The F# original is a hand-written balanced binary tree (~3900 LOC)
// providing a sorted map keyed by an IComparer<Key>. This port uses a
// sorted-array representation with binary search:
//
//   storage:  ReadonlyArray<[K, V]> sorted by key
//   find:     binary search, O(log N)
//   add/del:  copy + insert at sorted position, O(N)
//   slice:    copy + slice, O(N)
//   merge:    linear scan, O(N+M)
//
// Trade-offs match the HashCollections decision: faster to land,
// reliable correctness, the same public API surface, and the option
// of swapping in a balanced-tree implementation later under the same
// API.
//
// PORT NOTE — KEYING:
// MapExt takes an IComparer<K>. We accept a `(a: K, b: K) => number`
// comparator and an optional fallback for the default total order on
// numbers / strings.

export type KeyComparer<K> = (a: K, b: K) => number;

export const defaultCompareKeys: KeyComparer<unknown> = (a, b) => {
  if (Object.is(a, b)) return 0;
  if ((a as number) < (b as number)) return -1;
  return 1;
};

/// Binary search returning the insertion index (rightmost position).
/// Returns the index of the first element >= key, or arr.length if all
/// keys are < key.
function lowerBound<K, V>(
  arr: ReadonlyArray<[K, V]>,
  key: K,
  cmp: KeyComparer<K>,
): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = cmp(arr[mid]![0], key);
    if (c < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/// Binary search for an exact match. Returns -1 if absent.
function exactIndex<K, V>(
  arr: ReadonlyArray<[K, V]>,
  key: K,
  cmp: KeyComparer<K>,
): number {
  const lo = lowerBound(arr, key, cmp);
  if (lo < arr.length && cmp(arr[lo]![0], key) === 0) return lo;
  return -1;
}

export class MapExt<K, V> implements Iterable<[K, V]> {
  private readonly _entries: ReadonlyArray<[K, V]>;
  private readonly _cmp: KeyComparer<K>;

  /** @internal */
  constructor(entries: ReadonlyArray<[K, V]>, cmp: KeyComparer<K>) {
    this._entries = entries;
    this._cmp = cmp;
  }

  get count(): number {
    return this._entries.length;
  }
  get isEmpty(): boolean {
    return this._entries.length === 0;
  }

  /** @internal */
  get _cmpFn(): KeyComparer<K> {
    return this._cmp;
  }
  /** @internal */
  get _entriesArr(): ReadonlyArray<[K, V]> {
    return this._entries;
  }

  containsKey(key: K): boolean {
    return exactIndex(this._entries, key, this._cmp) >= 0;
  }

  tryFind(key: K): V | undefined {
    const i = exactIndex(this._entries, key, this._cmp);
    return i >= 0 ? this._entries[i]![1] : undefined;
  }

  find(key: K): V {
    const v = this.tryFind(key);
    if (v === undefined && !this.containsKey(key)) {
      throw new Error(`MapExt: key not found: ${String(key)}`);
    }
    return v as V;
  }

  add(key: K, value: V): MapExt<K, V> {
    const i = lowerBound(this._entries, key, this._cmp);
    const next = this._entries.slice();
    if (i < next.length && this._cmp(next[i]![0], key) === 0) {
      next[i] = [key, value];
    } else {
      next.splice(i, 0, [key, value]);
    }
    return new MapExt<K, V>(next, this._cmp);
  }

  remove(key: K): MapExt<K, V> {
    const i = exactIndex(this._entries, key, this._cmp);
    if (i < 0) return this;
    const next = this._entries.slice();
    next.splice(i, 1);
    return new MapExt<K, V>(next, this._cmp);
  }

  tryRemove(key: K): { value: V; rest: MapExt<K, V> } | undefined {
    const i = exactIndex(this._entries, key, this._cmp);
    if (i < 0) return undefined;
    const value = this._entries[i]![1];
    const next = this._entries.slice();
    next.splice(i, 1);
    return { value, rest: new MapExt<K, V>(next, this._cmp) };
  }

  alter(
    key: K,
    update: (existing: V | undefined) => V | undefined,
  ): MapExt<K, V> {
    const i = exactIndex(this._entries, key, this._cmp);
    const existing = i >= 0 ? this._entries[i]![1] : undefined;
    const next = update(i >= 0 ? existing : undefined);
    if (next === undefined) {
      return i >= 0 ? this.remove(key) : this;
    }
    if (i >= 0 && Object.is(existing, next)) return this;
    return this.add(key, next);
  }

  // F# `change` is an alias of `alter` semantically.
  change = this.alter;
  changeV = this.alter;

  iter(action: (k: K, v: V) => void): void {
    for (const [k, v] of this._entries) action(k, v);
  }

  fold<S>(folder: (s: S, k: K, v: V) => S, state: S): S {
    let s = state;
    for (const [k, v] of this._entries) s = folder(s, k, v);
    return s;
  }

  exists(predicate: (k: K, v: V) => boolean): boolean {
    for (const [k, v] of this._entries) if (predicate(k, v)) return true;
    return false;
  }

  forall(predicate: (k: K, v: V) => boolean): boolean {
    for (const [k, v] of this._entries) if (!predicate(k, v)) return false;
    return true;
  }

  map<U>(mapping: (k: K, v: V) => U): MapExt<K, U> {
    const next: Array<[K, U]> = new Array(this._entries.length);
    for (let i = 0; i < this._entries.length; i++) {
      const [k, v] = this._entries[i]!;
      next[i] = [k, mapping(k, v)];
    }
    return new MapExt<K, U>(next, this._cmp);
  }

  choose<U>(mapping: (k: K, v: V) => U | undefined): MapExt<K, U> {
    const next: Array<[K, U]> = [];
    for (const [k, v] of this._entries) {
      const u = mapping(k, v);
      if (u !== undefined) next.push([k, u]);
    }
    return new MapExt<K, U>(next, this._cmp);
  }

  filter(predicate: (k: K, v: V) => boolean): MapExt<K, V> {
    const next: Array<[K, V]> = [];
    for (const [k, v] of this._entries) {
      if (predicate(k, v)) next.push([k, v]);
    }
    return new MapExt<K, V>(next, this._cmp);
  }

  partition(
    predicate: (k: K, v: V) => boolean,
  ): { yes: MapExt<K, V>; no: MapExt<K, V> } {
    const yes: Array<[K, V]> = [];
    const no: Array<[K, V]> = [];
    for (const [k, v] of this._entries) {
      if (predicate(k, v)) yes.push([k, v]);
      else no.push([k, v]);
    }
    return {
      yes: new MapExt<K, V>(yes, this._cmp),
      no: new MapExt<K, V>(no, this._cmp),
    };
  }

  /// Returns the smallest [key, value] pair, or undefined if empty.
  tryMin(): [K, V] | undefined {
    return this._entries.length === 0 ? undefined : this._entries[0]!;
  }
  /// Returns the largest [key, value] pair, or undefined if empty.
  tryMax(): [K, V] | undefined {
    return this._entries.length === 0
      ? undefined
      : this._entries[this._entries.length - 1]!;
  }

  get minKey(): K {
    if (this._entries.length === 0) throw new Error("MapExt is empty");
    return this._entries[0]![0];
  }
  get maxKey(): K {
    if (this._entries.length === 0) throw new Error("MapExt is empty");
    return this._entries[this._entries.length - 1]![0];
  }

  /// Truncates the map keeping entries with key >= minKey.
  withMin(minKey: K): MapExt<K, V> {
    const i = lowerBound(this._entries, minKey, this._cmp);
    if (i === 0) return this;
    return new MapExt<K, V>(this._entries.slice(i), this._cmp);
  }

  /// Truncates the map keeping entries with key <= maxKey.
  withMax(maxKey: K): MapExt<K, V> {
    let i = lowerBound(this._entries, maxKey, this._cmp);
    if (i < this._entries.length && this._cmp(this._entries[i]![0], maxKey) === 0) {
      i += 1;
    }
    if (i === this._entries.length) return this;
    return new MapExt<K, V>(this._entries.slice(0, i), this._cmp);
  }

  /// Entries with minKey <= key <= maxKey.
  slice(minKey: K, maxKey: K): MapExt<K, V> {
    const lo = lowerBound(this._entries, minKey, this._cmp);
    let hi = lowerBound(this._entries, maxKey, this._cmp);
    if (hi < this._entries.length && this._cmp(this._entries[hi]![0], maxKey) === 0) {
      hi += 1;
    }
    return new MapExt<K, V>(this._entries.slice(lo, hi), this._cmp);
  }

  /// Returns the immediate predecessor and successor entries to `key`,
  /// plus the value at `key` itself if present. Used by IndexMapping
  /// and IndexList for stable-position insertion.
  ///
  /// Result: { left: [k,v]|undefined, self: V|undefined,
  ///           right: [k,v]|undefined }.
  neighbours(key: K): {
    left: [K, V] | undefined;
    self: V | undefined;
    right: [K, V] | undefined;
  } {
    const i = lowerBound(this._entries, key, this._cmp);
    let self: V | undefined = undefined;
    let leftIdx: number;
    let rightIdx: number;
    if (i < this._entries.length && this._cmp(this._entries[i]![0], key) === 0) {
      self = this._entries[i]![1];
      leftIdx = i - 1;
      rightIdx = i + 1;
    } else {
      leftIdx = i - 1;
      rightIdx = i;
    }
    return {
      left: leftIdx >= 0 ? this._entries[leftIdx]! : undefined,
      self,
      right:
        rightIdx < this._entries.length
          ? this._entries[rightIdx]!
          : undefined,
    };
  }

  /// Update at a key, with access to its neighbours. Used by
  /// IndexMapping (Utilities.fs) for stable-key allocation.
  changeWithNeighbours(
    key: K,
    update: (
      left: [K, V] | undefined,
      self: V | undefined,
      right: [K, V] | undefined,
    ) => V | undefined,
  ): MapExt<K, V> {
    const n = this.neighbours(key);
    const next = update(n.left, n.self, n.right);
    if (next === undefined) {
      if (n.self === undefined) return this;
      return this.remove(key);
    }
    if (n.self !== undefined && Object.is(n.self, next)) return this;
    return this.add(key, next);
  }

  /// Return the entry at zero-based index `i` (in sorted order).
  itemV(i: number): [K, V] | undefined {
    if (i < 0 || i >= this._entries.length) return undefined;
    return this._entries[i]!;
  }

  /// Index of the given key in sorted order, or -1 if absent.
  tryGetIndex(key: K): number {
    return exactIndex(this._entries, key, this._cmp);
  }

  union(other: MapExt<K, V>): MapExt<K, V> {
    return this.unionWith(other, (_k, _l, r) => r);
  }

  unionWith(
    other: MapExt<K, V>,
    resolve: (k: K, l: V, r: V) => V,
  ): MapExt<K, V> {
    if (this._entries.length === 0) return other;
    if (other._entries.length === 0) return this;
    const a = this._entries;
    const b = other._entries;
    const result: Array<[K, V]> = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const c = this._cmp(a[i]![0], b[j]![0]);
      if (c < 0) {
        result.push(a[i]!);
        i++;
      } else if (c > 0) {
        result.push(b[j]!);
        j++;
      } else {
        result.push([a[i]![0], resolve(a[i]![0], a[i]![1], b[j]![1])]);
        i++;
        j++;
      }
    }
    while (i < a.length) result.push(a[i++]!);
    while (j < b.length) result.push(b[j++]!);
    return new MapExt<K, V>(result, this._cmp);
  }

  toList(): Array<[K, V]> {
    return [...this._entries];
  }
  toArray(): Array<[K, V]> {
    return [...this._entries];
  }
  toKeyList(): K[] {
    return this._entries.map((kv) => kv[0]);
  }
  toValueList(): V[] {
    return this._entries.map((kv) => kv[1]);
  }
  toSeq(): Iterable<[K, V]> {
    return this;
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const e of this._entries) yield e;
  }

  /// Apply a delta against this map, emitting both the new state and
  /// the effective delta. Mirrors IndexList.applyDeltaAndGetEffective.
  applyDeltaAndGetEffective<D, DOut>(
    delta: MapExt<K, D>,
    apply: (
      k: K,
      existing: V | undefined,
      d: D,
    ) => [V | undefined, DOut | undefined],
  ): { state: MapExt<K, V>; effective: MapExt<K, DOut> } {
    let state = this as MapExt<K, V>;
    let eff: Array<[K, DOut]> = [];
    for (const [k, d] of delta) {
      const existing = state.tryFind(k);
      const had = state.containsKey(k);
      const [newValue, emitted] = apply(k, had ? existing : undefined, d);
      if (newValue === undefined) {
        if (had) state = state.remove(k);
      } else {
        state = state.add(k, newValue);
      }
      if (emitted !== undefined) eff.push([k, emitted]);
    }
    // Effective deltas come out in delta-iteration order which may not
    // be sorted; sort them via the comparator.
    eff = eff.slice().sort((a, b) => this._cmp(a[0], b[0]));
    return {
      state,
      effective: new MapExt<K, DOut>(eff, this._cmp as unknown as KeyComparer<K>),
    };
  }

  /// Compute a delta-as-MapExt mapping from this to `other` using
  /// per-key add/remove/update callbacks. Used by IndexList.computeDelta.
  computeDeltaTo<D>(
    other: MapExt<K, V>,
    add: (k: K, v: V) => D,
    update: (k: K, oldV: V, newV: V) => D | undefined,
    remove: (k: K, v: V) => D,
  ): MapExt<K, D> {
    const result: Array<[K, D]> = [];
    const a = this._entries;
    const b = other._entries;
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const c = this._cmp(a[i]![0], b[j]![0]);
      if (c < 0) {
        result.push([a[i]![0], remove(a[i]![0], a[i]![1])]);
        i++;
      } else if (c > 0) {
        result.push([b[j]![0], add(b[j]![0], b[j]![1])]);
        j++;
      } else {
        const u = update(a[i]![0], a[i]![1], b[j]![1]);
        if (u !== undefined) result.push([a[i]![0], u]);
        i++;
        j++;
      }
    }
    while (i < a.length) {
      result.push([a[i]![0], remove(a[i]![0], a[i]![1])]);
      i++;
    }
    while (j < b.length) {
      result.push([b[j]![0], add(b[j]![0], b[j]![1])]);
      j++;
    }
    return new MapExt<K, D>(result, this._cmp as unknown as KeyComparer<K>);
  }

  // ----- static factories -----

  static empty<K, V>(cmp: KeyComparer<K>): MapExt<K, V> {
    return new MapExt<K, V>([], cmp);
  }

  static single<K, V>(key: K, value: V, cmp: KeyComparer<K>): MapExt<K, V> {
    return new MapExt<K, V>([[key, value]], cmp);
  }

  static ofSeq<K, V>(
    elements: Iterable<[K, V]>,
    cmp: KeyComparer<K>,
  ): MapExt<K, V> {
    let m = MapExt.empty<K, V>(cmp);
    for (const [k, v] of elements) m = m.add(k, v);
    return m;
  }
  static ofArray<K, V>(
    elements: Array<[K, V]>,
    cmp: KeyComparer<K>,
  ): MapExt<K, V> {
    return MapExt.ofSeq(elements, cmp);
  }
  static ofList<K, V>(
    elements: Array<[K, V]>,
    cmp: KeyComparer<K>,
  ): MapExt<K, V> {
    return MapExt.ofSeq(elements, cmp);
  }
}
