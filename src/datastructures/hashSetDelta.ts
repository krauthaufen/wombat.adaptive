// Port of FSharp.Data.Adaptive Datastructures/HashSetDelta.fs
//
// Faithful port — depends only on HashMap and SetOperation, both of
// which are stable. Internal storage is `HashMap<T, number>` exactly
// as in F#: positive counts are adds, negative are removes, zero
// entries are pruned.

import { HashMap } from "./hashCollections.js";
import { SetOperation } from "./operations.js";

/// Represents the difference of two HashSets. Internally uses
/// reference counts to represent deltas and provides convenient
/// combine functions.
export class HashSetDelta<T> implements Iterable<SetOperation<T>> {
  private readonly _store: HashMap<T, number>;

  /** @internal */
  constructor(store: HashMap<T, number>) {
    this._store = store;
  }

  /// The internal store used by the HashSetDelta.
  get store(): HashMap<T, number> {
    return this._store;
  }

  get count(): number {
    return this._store.count;
  }
  get isEmpty(): boolean {
    return this._store.isEmpty;
  }

  /// Adds a SetOperation to the HashSetDelta.
  add(op: SetOperation<T>): HashSetDelta<T> {
    if (op.count === 0) return this;
    const next = this._store.alter(op.value, (existing) => {
      const n = existing === undefined ? op.count : existing + op.count;
      return n === 0 ? undefined : n;
    });
    return new HashSetDelta<T>(next);
  }

  /// Removes a SetOperation (i.e. adds its inverse).
  remove(op: SetOperation<T>): HashSetDelta<T> {
    return this.add(op.inverse);
  }

  /// Inverse of all operations.
  get inverse(): HashSetDelta<T> {
    return new HashSetDelta<T>(this._store.map((_k, v) => -v));
  }

  /// Combines two HashSetDeltas using a reference-counting union.
  combine(other: HashSetDelta<T>): HashSetDelta<T> {
    let combined = this._store;
    for (const [k, v] of other._store) {
      combined = combined.alter(k, (existing) => {
        const n = (existing ?? 0) + v;
        return n === 0 ? undefined : n;
      });
    }
    return new HashSetDelta<T>(combined);
  }

  map<U>(mapping: (op: SetOperation<T>) => SetOperation<U>): HashSetDelta<U> {
    let res = HashSetDelta.empty<U>();
    if (!this._store.isEmpty) {
      this._store.iter((k, v) => {
        res = res.add(mapping(new SetOperation(k, v)));
      });
    }
    return res;
  }

  choose<U>(
    f: (op: SetOperation<T>) => SetOperation<U> | undefined,
  ): HashSetDelta<U> {
    let res = HashSetDelta.empty<U>();
    if (!this._store.isEmpty) {
      this._store.iter((k, v) => {
        const r = f(new SetOperation(k, v));
        if (r !== undefined) res = res.add(r);
      });
    }
    return res;
  }

  filter(f: (op: SetOperation<T>) => boolean): HashSetDelta<T> {
    if (this._store.isEmpty) return HashSetDelta.empty<T>();
    return new HashSetDelta<T>(
      this._store.filter((k, v) => f(new SetOperation(k, v))),
    );
  }

  collect<U>(
    f: (op: SetOperation<T>) => HashSetDelta<U>,
  ): HashSetDelta<U> {
    let res = HashSetDelta.empty<U>();
    if (!this._store.isEmpty) {
      this._store.iter((k, v) => {
        res = res.combine(f(new SetOperation(k, v)));
      });
    }
    return res;
  }

  iter(f: (op: SetOperation<T>) => void): void {
    if (!this._store.isEmpty) {
      this._store.iter((k, v) => f(new SetOperation(k, v)));
    }
  }

  fold<S>(seed: S, f: (state: S, op: SetOperation<T>) => S): S {
    return this._store.fold((s, k, v) => f(s, new SetOperation(k, v)), seed);
  }

  exists(f: (op: SetOperation<T>) => boolean): boolean {
    return this._store.exists((k, v) => f(new SetOperation(k, v)));
  }

  forall(f: (op: SetOperation<T>) => boolean): boolean {
    return this._store.forall((k, v) => f(new SetOperation(k, v)));
  }

  toSeq(): Iterable<SetOperation<T>> {
    return this;
  }

  toList(): SetOperation<T>[] {
    return [...this];
  }

  toArray(): SetOperation<T>[] {
    return [...this];
  }

  /// Returns the underlying HashMap. O(1).
  toMap(): HashMap<T, number> {
    return this._store;
  }

  *[Symbol.iterator](): IterableIterator<SetOperation<T>> {
    for (const [k, v] of this._store) yield new SetOperation(k, v);
  }

  equals(other: HashSetDelta<T>): boolean {
    return this._store.equals(other._store);
  }

  toString(): string {
    const items = this.toList()
      .slice(0, 5)
      .map((op) => op.toString())
      .join("; ");
    return `HashSetDelta [${items}${this.count > 5 ? "; ..." : ""}]`;
  }

  // ----- static factories -----

  static empty<T>(): HashSetDelta<T> {
    return new HashSetDelta<T>(HashMap.empty<T, number>());
  }

  static ofSeq<T>(seq: Iterable<SetOperation<T>>): HashSetDelta<T> {
    let res = HashSetDelta.empty<T>();
    for (const e of seq) res = res.add(e);
    return res;
  }

  static ofList<T>(list: SetOperation<T>[]): HashSetDelta<T> {
    return HashSetDelta.ofSeq(list);
  }

  static ofArray<T>(arr: SetOperation<T>[]): HashSetDelta<T> {
    return HashSetDelta.ofSeq(arr);
  }

  static ofHashMap<T>(map: HashMap<T, number>): HashSetDelta<T> {
    return new HashSetDelta<T>(map);
  }

  static single<T>(op: SetOperation<T>): HashSetDelta<T> {
    return new HashSetDelta<T>(HashMap.single<T, number>(op.value, op.count));
  }
}

export const HashSetDeltaOps = {
  empty: <T>() => HashSetDelta.empty<T>(),
  isEmpty: <T>(s: HashSetDelta<T>) => s.isEmpty,
  count: <T>(s: HashSetDelta<T>) => s.count,
  inverse: <T>(s: HashSetDelta<T>) => s.inverse,
  single: <T>(op: SetOperation<T>) => HashSetDelta.single(op),
  ofSeq: <T>(seq: Iterable<SetOperation<T>>) => HashSetDelta.ofSeq(seq),
  ofList: <T>(list: SetOperation<T>[]) => HashSetDelta.ofList(list),
  ofArray: <T>(arr: SetOperation<T>[]) => HashSetDelta.ofArray(arr),
  ofHashMap: <T>(map: HashMap<T, number>) => HashSetDelta.ofHashMap(map),
  toSeq: <T>(s: HashSetDelta<T>) => s.toSeq(),
  toList: <T>(s: HashSetDelta<T>) => s.toList(),
  toArray: <T>(s: HashSetDelta<T>) => s.toArray(),
  toHashMap: <T>(s: HashSetDelta<T>) => s.toMap(),
  add: <T>(op: SetOperation<T>, s: HashSetDelta<T>) => s.add(op),
  remove: <T>(op: SetOperation<T>, s: HashSetDelta<T>) => s.remove(op),
  combine: <T>(l: HashSetDelta<T>, r: HashSetDelta<T>) => l.combine(r),
  map: <T, U>(f: (op: SetOperation<T>) => SetOperation<U>, s: HashSetDelta<T>) =>
    s.map(f),
  choose: <T, U>(
    f: (op: SetOperation<T>) => SetOperation<U> | undefined,
    s: HashSetDelta<T>,
  ) => s.choose(f),
  filter: <T>(f: (op: SetOperation<T>) => boolean, s: HashSetDelta<T>) =>
    s.filter(f),
  collect: <T, U>(
    f: (op: SetOperation<T>) => HashSetDelta<U>,
    s: HashSetDelta<T>,
  ) => s.collect(f),
  iter: <T>(f: (op: SetOperation<T>) => void, s: HashSetDelta<T>) => s.iter(f),
  exists: <T>(f: (op: SetOperation<T>) => boolean, s: HashSetDelta<T>) =>
    s.exists(f),
  forall: <T>(f: (op: SetOperation<T>) => boolean, s: HashSetDelta<T>) =>
    s.forall(f),
  fold: <T, S>(
    folder: (state: S, op: SetOperation<T>) => S,
    seed: S,
    s: HashSetDelta<T>,
  ) => s.fold(seed, folder),
};
