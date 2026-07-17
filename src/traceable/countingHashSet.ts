// Port of FSharp.Data.Adaptive Traceable/CountingHashSet.fs

import { HashMap, HashSet } from "../datastructures/hashCollections.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import { SetOperation } from "../datastructures/operations.js";
import type { Monoid, Traceable } from "./traceable.js";

/** Set comparison result. */
export const enum SetCmp {
  Distinct = 0,
  ProperSubset = 1,
  ProperSuperset = 2,
  Overlap = 3,
  Equal = 4,
}

/** Monoid for HashSetDelta — combine via reference-counted union. */
function hashSetDeltaMonoidImpl<T>(): Monoid<HashSetDelta<T>> {
  return {
    mempty: HashSetDelta.empty<T>(),
    mappend: (l, r) => l.combine(r),
    misEmpty: (s) => s.isEmpty,
  };
}

/**
 * A reference-counting set, used for tracing the unions of sets with
 * elements in common.
 *
 * Example:
 *   a = {1, 2, 3}
 *   b = {1}
 *   c = union a b   // {1, 2, 3}
 *   a.remove 1
 *   c = {1, 2, 3}   // still — 1 was contained twice
 *
 * The ref-counted internal representation makes reader implementations
 * straightforward — they don't need to track duplicates manually.
 */
export class CountingHashSet<T> implements Iterable<T> {
  private readonly _store: HashMap<T, number>;

  /** @internal */
  constructor(store: HashMap<T, number>) {
    this._store = store;
  }

  static empty<T>(): CountingHashSet<T> {
    return new CountingHashSet<T>(HashMap.empty<T, number>());
  }

  /** Is the set empty? */
  get isEmpty(): boolean {
    return this._store.isEmpty;
  }

  /** The number of distinct entries (excluding ref-counts). */
  get count(): number {
    return this._store.count;
  }

  /** @internal */
  get store(): HashMap<T, number> {
    return this._store;
  }

  /** Creates a HashSet with the same entries (one entry per distinct key). */
  toHashSet(): HashSet<T> {
    return this._store.getKeys();
  }

  contains(value: T): boolean {
    return this._store.containsKey(value);
  }

  /** Reference-count for the given value (0 if not contained). */
  getRefCount(value: T): number {
    const v = this._store.tryFind(value);
    return v === undefined ? 0 : v;
  }

  /** Adds one reference to the given value. */
  add(value: T): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.alter(value, (o) => (o === undefined ? 1 : o + 1)),
    );
  }

  /** Removes one reference; the value disappears at zero refs. */
  remove(value: T): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.alter(value, (o) => {
        if (o !== undefined && o > 1) return o - 1;
        return undefined;
      }),
    );
  }

  /** Updates the reference-count for the given element via callback. */
  alter(value: T, f: (existing: number) => number): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.alter(value, (o) => {
        const n = f(o ?? 0);
        return n > 0 ? n : undefined;
      }),
    );
  }

  /** Unions two sets, summing reference-counts. */
  union(other: CountingHashSet<T>): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.unionWith(other._store, (_k, l, r) => l + r),
    );
  }

  /** Set difference: this − other. */
  difference(other: CountingHashSet<T>): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.choose2V<number, number>(other._store, (_k, l, r) => {
        if (l === undefined) return undefined;
        if (r === undefined) return l;
        const n = l - r;
        return n > 0 ? n : undefined;
      }),
    );
  }

  /** Intersection (per-key min refcount). */
  intersect(other: CountingHashSet<T>): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.choose2V<number, number>(other._store, (_k, l, r) => {
        if (l === undefined) return undefined;
        if (r === undefined) return undefined;
        return Math.min(l, r);
      }),
    );
  }

  /** Symmetric difference (refcounts retained from the side that has the key). */
  xor(other: CountingHashSet<T>): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.choose2V<number, number>(other._store, (_k, l, r) => {
        if (l !== undefined) {
          if (r !== undefined) return undefined;
          return l;
        }
        return r;
      }),
    );
  }

  /** Combine via custom resolver (refcounts → refcount, 0 ⇒ remove). */
  unionWith(
    other: CountingHashSet<T>,
    resolve: (l: number, r: number) => number,
  ): CountingHashSet<T> {
    return new CountingHashSet<T>(
      this._store.choose2V<number, number>(other._store, (_k, l, r) => {
        const lv = l ?? 0;
        const rv = r ?? 0;
        const res = resolve(lv, rv);
        return res > 0 ? res : undefined;
      }),
    );
  }

  toHashMap(): HashMap<T, number> {
    return this._store;
  }
  toSeq(): Iterable<T> {
    return this._store.getKeys();
  }
  toList(): T[] {
    return this._store.toKeyList();
  }
  toArray(): T[] {
    return this._store.toKeyArray();
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (const k of this._store.getKeys()) yield k;
  }

  /** Map over distinct keys; equal target keys collapse summing refcounts. */
  map<U>(mapping: (k: T) => U): CountingHashSet<U> {
    let res = HashMap.empty<U, number>();
    for (const [k, v] of this._store) {
      const mk = mapping(k);
      res = res.alter(mk, (o) => (o ?? 0) + v);
    }
    return new CountingHashSet<U>(res);
  }

  choose<U>(mapping: (k: T) => U | undefined): CountingHashSet<U> {
    let res = HashMap.empty<U, number>();
    for (const [k, v] of this._store) {
      const mk = mapping(k);
      if (mk !== undefined) {
        res = res.alter(mk, (o) => (o ?? 0) + v);
      }
    }
    return new CountingHashSet<U>(res);
  }

  filter(predicate: (k: T) => boolean): CountingHashSet<T> {
    return new CountingHashSet<T>(this._store.filter((k, _v) => predicate(k)));
  }

  /**
   * Each element of the source contributes its refcount as a multiplier
   * for the inner CountingHashSet's refcounts. The resulting set unions
   * everything.
   */
  collect<U>(mapping: (k: T) => CountingHashSet<U>): CountingHashSet<U> {
    let res = HashMap.empty<U, number>();
    for (const [k, ro] of this._store) {
      const r = mapping(k);
      const apply = (
        _k: U,
        existing: number | undefined,
        delta: number,
      ): [number | undefined, never | undefined] => {
        const oldRef = existing ?? 0;
        return [oldRef + ro * delta, undefined];
      };
      const result = HashMap.applyDeltaV<U, number, number, never>(
        res,
        r._store,
        apply,
      );
      res = result.state;
    }
    return new CountingHashSet<U>(res);
  }

  iter(iterator: (k: T) => void): void {
    this._store.iter((k, _v) => iterator(k));
  }
  exists(predicate: (k: T) => boolean): boolean {
    return this._store.exists((k, _v) => predicate(k));
  }
  forall(predicate: (k: T) => boolean): boolean {
    return this._store.forall((k, _v) => predicate(k));
  }
  fold<S>(seed: S, folder: (s: S, k: T) => S): S {
    return this._store.fold((s, k, _v) => folder(s, k), seed);
  }

  // ----- factories -----

  static ofSeq<T>(seq: Iterable<T>): CountingHashSet<T> {
    let res = CountingHashSet.empty<T>();
    for (const e of seq) res = res.add(e);
    return res;
  }
  static ofList<T>(l: T[]): CountingHashSet<T> {
    return CountingHashSet.ofSeq(l);
  }
  static ofArray<T>(a: T[]): CountingHashSet<T> {
    return CountingHashSet.ofSeq(a);
  }
  static ofHashMap<T>(map: HashMap<T, number>): CountingHashSet<T> {
    return new CountingHashSet<T>(map.filter((_k, v) => v > 0));
  }
  static ofHashSet<T>(set: HashSet<T>): CountingHashSet<T> {
    let m = HashMap.empty<T, number>();
    for (const k of set) m = m.add(k, 1);
    return new CountingHashSet<T>(m);
  }

  /** Differentiates two sets, returning a HashSetDelta. */
  computeDelta(other: CountingHashSet<T>): HashSetDelta<T> {
    let m = HashMap.empty<T, number>();
    for (const [k] of this._store) {
      if (!other._store.containsKey(k)) m = m.add(k, -1);
    }
    for (const [k] of other._store) {
      if (!this._store.containsKey(k)) m = m.add(k, 1);
    }
    return HashSetDelta.ofHashMap(m);
  }

  /** Same as `this.computeDelta(empty)`. */
  removeAll(): HashSetDelta<T> {
    return HashSetDelta.ofHashMap(this._store.map((_k, _v) => -1));
  }

  /** Same as `empty.computeDelta(this)`. */
  addAll(): HashSetDelta<T> {
    return HashSetDelta.ofHashMap(this._store.map((_k, _v) => 1));
  }

  /**
   * Integrates the given delta into the set. Returns a new set and the
   * effective deltas (cleaned of redundant adds/removes).
   */
  applyDelta(
    delta: HashSetDelta<T>,
  ): { state: CountingHashSet<T>; effective: HashSetDelta<T> } {
    const apply = (
      _k: T,
      existing: number | undefined,
      d: number,
    ): [number | undefined, number | undefined] => {
      const o = existing ?? 0;
      const n = d + o;
      let dlt: number | undefined = undefined;
      if (o <= 0 && n > 0) dlt = 1;
      else if (o > 0 && n <= 0) dlt = -1;
      const value = n <= 0 ? undefined : n;
      return [value, dlt];
    };
    const r = HashMap.applyDeltaV<T, number, number, number>(
      this._store,
      delta.toMap(),
      apply,
    );
    return {
      state: new CountingHashSet<T>(r.state),
      effective: HashSetDelta.ofHashMap(r.effective),
    };
  }

  /** Same as `applyDelta` but ignores ref-counts (treats as plain set). */
  applyDeltaNoRefCount(
    delta: HashSetDelta<T>,
  ): { state: CountingHashSet<T>; effective: HashSetDelta<T> } {
    const apply = (
      _k: T,
      existing: number | undefined,
      d: number,
    ): [number | undefined, number | undefined] => {
      const o = existing !== undefined ? 1 : 0;
      const n = d > 0 ? 1 : d < 0 ? 0 : o;
      let dlt: number | undefined = undefined;
      if (o === 0 && n > 0) dlt = 1;
      else if (o > 0 && n === 0) dlt = -1;
      const value = n <= 0 ? undefined : n;
      return [value, dlt];
    };
    const r = HashMap.applyDeltaV<T, number, number, number>(
      this._store,
      delta.toMap(),
      apply,
    );
    return {
      state: new CountingHashSet<T>(r.state),
      effective: HashSetDelta.ofHashMap(r.effective),
    };
  }

  /** @internal Compares two sets returning a SetCmp value. */
  static compare<T>(
    l: CountingHashSet<T>,
    r: CountingHashSet<T>,
  ): SetCmp {
    const i = l.intersect(r);
    const b = i.count;
    const lo = l.count - b;
    const ro = r.count - b;
    if (lo === 0 && ro === 0) return SetCmp.Equal;
    if (b === 0) return SetCmp.Distinct;
    if (ro === 0) return SetCmp.ProperSuperset;
    if (lo === 0) return SetCmp.ProperSubset;
    return SetCmp.Overlap;
  }

  toString(): string {
    const items = this.toList()
      .slice(0, 5)
      .map((x) => String(x))
      .join("; ");
    return `CountingHashSet [${items}${this.count > 5 ? "; ..." : ""}]`;
  }

  /** Traceable instance — full ref-counting semantics. */
  static trace<T>(): Traceable<CountingHashSet<T>, HashSetDelta<T>> {
    return _countingTrace as unknown as Traceable<CountingHashSet<T>, HashSetDelta<T>>;
  }
  /** @internal builds the (stateless) record — called once. */
  static traceImpl<T>(): Traceable<CountingHashSet<T>, HashSetDelta<T>> {
    return {
      tmonoid: hashSetDeltaMonoid<T>(),
      tempty: CountingHashSet.empty<T>(),
      tapplyDelta: (s, d) => {
        const r = s.applyDelta(d);
        return [r.state, r.effective];
      },
      tcomputeDelta: (l, r) => l.computeDelta(r),
      tprune: undefined,
      tsize: (d) => d.count,
    };
  }

  /** Traceable instance ignoring reference counts (set semantics). */
  static traceNoRefCount<T>(): Traceable<CountingHashSet<T>, HashSetDelta<T>> {
    return _countingTraceNoRef as unknown as Traceable<CountingHashSet<T>, HashSetDelta<T>>;
  }
  /** @internal builds the (stateless) record — called once. */
  static traceNoRefCountImpl<T>(): Traceable<CountingHashSet<T>, HashSetDelta<T>> {
    return {
      tmonoid: hashSetDeltaMonoid<T>(),
      tempty: CountingHashSet.empty<T>(),
      tapplyDelta: (s, d) => {
        const r = s.applyDeltaNoRefCount(d);
        return [r.state, r.effective];
      },
      tcomputeDelta: (l, r) => l.computeDelta(r),
      tprune: undefined,
      tsize: (d) => d.count,
    };
  }
}

/** Convenience namespace mirroring the F# `module CountingHashSet` surface. */
export const CountingHashSetOps = {
  empty: <T>() => CountingHashSet.empty<T>(),
  single: <T>(v: T) => new CountingHashSet<T>(HashMap.single(v, 1)),
  toHashMap: <T>(s: CountingHashSet<T>) => s.toHashMap(),
  toSeq: <T>(s: CountingHashSet<T>) => s.toSeq(),
  toList: <T>(s: CountingHashSet<T>) => s.toList(),
  toArray: <T>(s: CountingHashSet<T>) => s.toArray(),
  toHashSet: <T>(s: CountingHashSet<T>) => s.toHashSet(),
  ofHashMap: <T>(m: HashMap<T, number>) => CountingHashSet.ofHashMap(m),
  ofHashSet: <T>(s: HashSet<T>) => CountingHashSet.ofHashSet(s),
  ofSeq: <T>(s: Iterable<T>) => CountingHashSet.ofSeq(s),
  ofList: <T>(l: T[]) => CountingHashSet.ofList(l),
  ofArray: <T>(a: T[]) => CountingHashSet.ofArray(a),
  isEmpty: <T>(s: CountingHashSet<T>) => s.isEmpty,
  count: <T>(s: CountingHashSet<T>) => s.count,
  refcount: <T>(v: T, s: CountingHashSet<T>) => s.getRefCount(v),
  contains: <T>(v: T, s: CountingHashSet<T>) => s.contains(v),
  add: <T>(v: T, s: CountingHashSet<T>) => s.add(v),
  remove: <T>(v: T, s: CountingHashSet<T>) => s.remove(v),
  union: <T>(a: CountingHashSet<T>, b: CountingHashSet<T>) => a.union(b),
  difference: <T>(a: CountingHashSet<T>, b: CountingHashSet<T>) => a.difference(b),
  intersect: <T>(a: CountingHashSet<T>, b: CountingHashSet<T>) => a.intersect(b),
  xor: <T>(a: CountingHashSet<T>, b: CountingHashSet<T>) => a.xor(b),
  alter: <T>(v: T, f: (n: number) => number, s: CountingHashSet<T>) =>
    s.alter(v, f),
  map: <A, B>(f: (k: A) => B, s: CountingHashSet<A>) => s.map(f),
  choose: <A, B>(f: (k: A) => B | undefined, s: CountingHashSet<A>) => s.choose(f),
  filter: <T>(p: (k: T) => boolean, s: CountingHashSet<T>) => s.filter(p),
  collect: <A, B>(
    f: (k: A) => CountingHashSet<B>,
    s: CountingHashSet<A>,
  ) => s.collect(f),
  iter: <T>(f: (k: T) => void, s: CountingHashSet<T>) => s.iter(f),
  exists: <T>(p: (k: T) => boolean, s: CountingHashSet<T>) => s.exists(p),
  forall: <T>(p: (k: T) => boolean, s: CountingHashSet<T>) => s.forall(p),
  fold: <T, S>(folder: (s: S, k: T) => S, seed: S, set: CountingHashSet<T>) =>
    set.fold(seed, folder),
  trace: <T>() => CountingHashSet.trace<T>(),
  traceNoRefCount: <T>() => CountingHashSet.traceNoRefCount<T>(),
  computeDelta: <T>(src: CountingHashSet<T>, dst: CountingHashSet<T>) =>
    src.computeDelta(dst),
  removeAll: <T>(src: CountingHashSet<T>) => src.removeAll(),
  addAll: <T>(src: CountingHashSet<T>) => src.addAll(),
  applyDelta: <T>(s: CountingHashSet<T>, d: HashSetDelta<T>) => s.applyDelta(d),
  applyDeltaNoRefCount: <T>(s: CountingHashSet<T>, d: HashSetDelta<T>) =>
    s.applyDeltaNoRefCount(d),
};

/** F# Traceable<HashSet<T>, HashSetDelta<T>> instance. */
function hashSetTraceImpl<T>(): Traceable<HashSet<T>, HashSetDelta<T>> {
  return {
    tmonoid: hashSetDeltaMonoid<T>(),
    tempty: HashSet.empty<T>(),
    tapplyDelta: (s, d) => {
      // Standard add(+1)/remove(-1) semantics directly on HashSet.
      let state = s;
      const effective: Array<[T, number]> = [];
      for (const op of d) {
        const has = state.contains(op.value);
        if (op.count > 0) {
          if (!has) {
            state = state.add(op.value);
            effective.push([op.value, 1]);
          }
        } else if (op.count < 0) {
          if (has) {
            state = state.remove(op.value);
            effective.push([op.value, -1]);
          }
        }
      }
      return [state, HashSetDelta.ofHashMap(HashMap.ofArray(effective))];
    },
    tcomputeDelta: (l, r) => {
      let m = HashMap.empty<T, number>();
      for (const k of l) if (!r.contains(k)) m = m.add(k, -1);
      for (const k of r) if (!l.contains(k)) m = m.add(k, 1);
      return HashSetDelta.ofHashMap(m);
    },
    tprune: undefined,
    tsize: (d) => d.count,
  };
}

/** F# Traceable<HashMap<K, V>, HashMapDelta<K, V>> instance. */
// Note: HashMapDelta lives in datastructures/hashMapDelta.ts; we'll need
// to import it. Provide a builder rather than a single value to keep
// generic instantiation per-call.
export {}; // ensure module shape stable

// Stateless records — ONE shared instance each (generics erased at
// runtime; fresh closure records per reader/history were a measured
// heap item at scene scale).
const _hashSetDeltaMonoid = hashSetDeltaMonoidImpl<unknown>();
const _countingTrace = CountingHashSet.traceImpl<unknown>();
const _countingTraceNoRef = CountingHashSet.traceNoRefCountImpl<unknown>();
const _hashSetTrace = hashSetTraceImpl<unknown>();

/** Monoid over `HashSetDelta<T>` (combine). */
export function hashSetDeltaMonoid<T>(): Monoid<HashSetDelta<T>> {
  return _hashSetDeltaMonoid as unknown as Monoid<HashSetDelta<T>>;
}

/** Traceable instance for plain `HashSet<T>`. */
export function hashSetTrace<T>(): Traceable<HashSet<T>, HashSetDelta<T>> {
  return _hashSetTrace as unknown as Traceable<HashSet<T>, HashSetDelta<T>>;
}
