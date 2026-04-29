// Port of FSharp.Data.Adaptive Datastructures/IndexList.fs
//
// PORT NOTE: focused subset matching the F# IndexList class API. Uses
// our `MapExt<Index, T>` for storage, with a comparator that delegates
// to `Index.compareTo`. Min/max bounds are tracked alongside the map
// for O(1) head/tail access.

import { Index, indexZero, IndexOps } from "./index.js";
import { MapExt, type KeyComparer } from "./mapExt.js";

const indexCmp: KeyComparer<Index> = (a, b) => a.compareTo(b);

const emptyMap: MapExt<Index, never> = MapExt.empty<Index, never>(indexCmp);

/**
 * A persistent array-like structure indexed by `Index`.
 * Insert/lookup/delete in O(N) (sorted-array storage). Public API
 * matches the F# `IndexList<T>`.
 */
export class IndexList<T> implements Iterable<T> {
  private readonly _l: Index;
  private readonly _h: Index;
  private readonly _content: MapExt<Index, T>;

  /** @internal */
  constructor(l: Index, h: Index, content: MapExt<Index, T>) {
    this._l = l;
    this._h = h;
    this._content = content;
  }

  /** @internal */
  get content(): MapExt<Index, T> {
    return this._content;
  }

  static empty<T>(): IndexList<T> {
    return new IndexList<T>(indexZero, indexZero, emptyMap as MapExt<Index, T>);
  }

  get minIndex(): Index {
    return this._l;
  }
  get maxIndex(): Index {
    return this._h;
  }
  get count(): number {
    return this._content.count;
  }
  get isEmpty(): boolean {
    return this._content.isEmpty;
  }

  // ----- by Index lookups -----

  tryGetByIndex(i: Index): T | undefined {
    return this._content.tryFind(i);
  }
  itemByIndex(i: Index): T {
    return this._content.find(i);
  }

  // ----- by int position lookups -----

  tryGetByPosition(i: number): T | undefined {
    const e = this._content.itemV(i);
    return e === undefined ? undefined : e[1];
  }
  item(i: number): T {
    const e = this._content.itemV(i);
    if (e === undefined) throw new Error(`IndexList: index ${i} out of range`);
    return e[1];
  }

  /** Append element to the end. */
  add(element: T): IndexList<T> {
    if (this._content.count === 0) {
      const t = IndexOps.after(indexZero);
      return new IndexList<T>(t, t, MapExt.single(t, element, indexCmp));
    }
    const t = IndexOps.after(this._h);
    return new IndexList<T>(this._l, t, this._content.add(t, element));
  }

  /** Prepend element to the front. */
  prepend(element: T): IndexList<T> {
    if (this._content.count === 0) {
      const t = IndexOps.after(indexZero);
      return new IndexList<T>(t, t, MapExt.single(t, element, indexCmp));
    }
    const t = IndexOps.before(this._l);
    return new IndexList<T>(t, this._h, this._content.add(t, element));
  }

  /** Set the element at the given Index, extending bounds if needed. */
  setByIndex(index: Index, value: T): IndexList<T> {
    if (this._content.count === 0) {
      return new IndexList<T>(index, index, MapExt.single(index, value, indexCmp));
    }
    const c = this._content.add(index, value);
    if (index.compareTo(this._l) < 0) return new IndexList<T>(index, this._h, c);
    if (index.compareTo(this._h) > 0) return new IndexList<T>(this._l, index, c);
    return new IndexList<T>(this._l, this._h, c);
  }

  /** Set the element at the given int position. No-op if out of range. */
  setByPosition(i: number, value: T): IndexList<T> {
    if (i < 0 || i >= this._content.count) return this;
    const e = this._content.itemV(i);
    if (e === undefined) return this;
    return this.setByIndex(e[0], value);
  }

  /** Update the element at the given int position via callback. */
  updateAt(i: number, update: (t: T) => T): IndexList<T> {
    const e = this._content.itemV(i);
    if (e === undefined) return this;
    const next = this._content.add(e[0], update(e[1]));
    return new IndexList<T>(this._l, this._h, next);
  }

  /** Insert at int position [0..count]. */
  insertAt(i: number, value: T): IndexList<T> {
    if (i < 0 || i > this._content.count) return this;
    if (this._content.count === 0) {
      return this.add(value);
    }
    if (i === 0) return this.prepend(value);
    if (i === this._content.count) return this.add(value);
    const before = this._content.itemV(i - 1)!;
    const after = this._content.itemV(i)!;
    const idx = IndexOps.between(before[0], after[0]);
    return this.setByIndex(idx, value);
  }

  /**
   * Insert directly before the given Index. If the index is not
   * present, behaves as `setByIndex`.
   */
  insertBefore(index: Index, value: T): IndexList<T> {
    const n = this._content.neighbours(index);
    if (n.self === undefined) return this.setByIndex(index, value);
    const newIndex =
      n.left !== undefined
        ? IndexOps.between(n.left[0], index)
        : IndexOps.before(index);
    return this.setByIndex(newIndex, value);
  }

  /**
   * Insert directly after the given Index. If the index is not
   * present, behaves as `setByIndex`.
   */
  insertAfter(index: Index, value: T): IndexList<T> {
    const n = this._content.neighbours(index);
    if (n.self === undefined) return this.setByIndex(index, value);
    const newIndex =
      n.right !== undefined
        ? IndexOps.between(index, n.right[0])
        : IndexOps.after(index);
    return this.setByIndex(newIndex, value);
  }

  /** Returns the Index for the given int position, or undefined. */
  tryGetIndex(i: number): Index | undefined {
    const e = this._content.itemV(i);
    return e === undefined ? undefined : e[0];
  }

  /** Returns the int position for the given Index, or -1 if absent. */
  tryGetPosition(idx: Index): number {
    return this._content.tryGetIndex(idx);
  }

  /** Removes the entry at the given Index. */
  removeByIndex(index: Index): IndexList<T> {
    if (!this._content.containsKey(index)) return this;
    const c = this._content.remove(index);
    if (c.count === 0) return IndexList.empty<T>();
    if (index.equals(this._l)) return new IndexList<T>(c.minKey, this._h, c);
    if (index.equals(this._h)) return new IndexList<T>(this._l, c.maxKey, c);
    return new IndexList<T>(this._l, this._h, c);
  }

  /** Removes the entry at the given int position. */
  removeAt(i: number): IndexList<T> {
    const e = this._content.itemV(i);
    if (e === undefined) return this;
    return this.removeByIndex(e[0]);
  }

  // ----- transformations -----

  map<U>(mapping: (i: Index, t: T) => U): IndexList<U> {
    return new IndexList<U>(this._l, this._h, this._content.map(mapping));
  }

  choose<U>(mapping: (i: Index, t: T) => U | undefined): IndexList<U> {
    const c = this._content.choose(mapping);
    if (c.isEmpty) return IndexList.empty<U>();
    return new IndexList<U>(c.minKey, c.maxKey, c);
  }

  filter(predicate: (i: Index, t: T) => boolean): IndexList<T> {
    const c = this._content.filter(predicate);
    if (c.isEmpty) return IndexList.empty<T>();
    return new IndexList<T>(c.minKey, c.maxKey, c);
  }

  partition(
    predicate: (i: Index, t: T) => boolean,
  ): { yes: IndexList<T>; no: IndexList<T> } {
    const { yes, no } = this._content.partition(predicate);
    const yesL = yes.isEmpty
      ? IndexList.empty<T>()
      : new IndexList<T>(yes.minKey, yes.maxKey, yes);
    const noL = no.isEmpty
      ? IndexList.empty<T>()
      : new IndexList<T>(no.minKey, no.maxKey, no);
    return { yes: yesL, no: noL };
  }

  iter(action: (i: Index, t: T) => void): void {
    this._content.iter(action);
  }
  fold<S>(folder: (s: S, i: Index, t: T) => S, state: S): S {
    return this._content.fold(folder, state);
  }
  exists(predicate: (i: Index, t: T) => boolean): boolean {
    return this._content.exists(predicate);
  }
  forall(predicate: (i: Index, t: T) => boolean): boolean {
    return this._content.forall(predicate);
  }

  // ----- conversions -----

  toList(): T[] {
    const out: T[] = [];
    for (const [, v] of this._content) out.push(v);
    return out;
  }
  toArray(): T[] {
    return this.toList();
  }
  toListIndexed(): Array<[Index, T]> {
    return this._content.toList();
  }
  toArrayIndexed(): Array<[Index, T]> {
    return this._content.toArray();
  }
  toSeq(): Iterable<T> {
    return this;
  }
  toSeqIndexed(): Iterable<[Index, T]> {
    return this._content;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (const [, v] of this._content) yield v;
  }

  // ----- range / slice helpers -----

  takeFirst(n: number): IndexList<T> {
    if (n <= 0) return IndexList.empty<T>();
    if (n >= this.count) return this;
    const slice = this._content.toArray().slice(0, n);
    return IndexList.fromMap(MapExt.ofArray(slice, indexCmp));
  }

  skipFirst(n: number): IndexList<T> {
    if (n <= 0) return this;
    if (n >= this.count) return IndexList.empty<T>();
    const slice = this._content.toArray().slice(n);
    return IndexList.fromMap(MapExt.ofArray(slice, indexCmp));
  }

  /**
   * Concatenate two IndexLists. New Indices are minted on the right
   * to slot strictly after the left's max.
   */
  static append<T>(a: IndexList<T>, b: IndexList<T>): IndexList<T> {
    if (a.isEmpty) return b;
    if (b.isEmpty) return a;
    let result = a;
    for (const v of b) result = result.add(v);
    return result;
  }

  // ----- factories -----

  static single<T>(value: T): IndexList<T> {
    const t = IndexOps.after(indexZero);
    return new IndexList<T>(t, t, MapExt.single(t, value, indexCmp));
  }

  static ofSeq<T>(elements: Iterable<T>): IndexList<T> {
    let r = IndexList.empty<T>();
    for (const v of elements) r = r.add(v);
    return r;
  }
  static ofArray<T>(elements: T[]): IndexList<T> {
    return IndexList.ofSeq(elements);
  }
  static ofList<T>(elements: T[]): IndexList<T> {
    return IndexList.ofSeq(elements);
  }

  /** Creates an IndexList covering the integer range [lower, upper]. */
  static range(lower: number, upper: number): IndexList<number> {
    const out: number[] = [];
    for (let i = lower; i <= upper; i++) out.push(i);
    return IndexList.ofArray(out);
  }

  /**
   * Creates an IndexList of the given length, populated by calling
   * `initializer` for each index in [0, length).
   */
  static init<T>(length: number, initializer: (i: number) => T): IndexList<T> {
    if (length < 0) throw new Error("IndexList.init: negative length");
    const out: T[] = new Array(length);
    for (let i = 0; i < length; i++) out[i] = initializer(i);
    return IndexList.ofArray(out);
  }

  /** @internal */
  static fromMap<T>(content: MapExt<Index, T>): IndexList<T> {
    if (content.isEmpty) return IndexList.empty<T>();
    return new IndexList<T>(content.minKey, content.maxKey, content);
  }

  // ----- additional transforms -----

  /**
   * Reverses the value sequence while preserving the actual Index
   * keys (so `minIndex` and `maxIndex` are stable).
   */
  rev(): IndexList<T> {
    if (this.count <= 1) return this;
    const arr = this._content.toArray();
    let res = MapExt.empty<Index, T>(indexCmp);
    let o = arr.length - 1;
    for (let i = 0; i < arr.length; i++) {
      const k = arr[i]![0];
      const v = arr[o]![1];
      res = res.add(k, v);
      o -= 1;
    }
    return new IndexList<T>(this._l, this._h, res);
  }

  /** Sub-range: `count` elements starting at int position `offset`. */
  sub(offset: number, count: number): IndexList<T> {
    if (count <= 0) return IndexList.empty<T>();
    return this.skipFirst(offset).takeFirst(count);
  }

  /** Sort by a key projection. */
  sortBy<U>(mapping: (t: T) => U, compare?: (a: U, b: U) => number): IndexList<T> {
    const cmp = compare ?? ((a: U, b: U) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted = this.toList().slice().sort((a, b) => cmp(mapping(a), mapping(b)));
    return IndexList.ofArray(sorted);
  }
  sortByDescending<U>(
    mapping: (t: T) => U,
    compare?: (a: U, b: U) => number,
  ): IndexList<T> {
    const cmp = compare ?? ((a: U, b: U) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted = this.toList().slice().sort((a, b) => -cmp(mapping(a), mapping(b)));
    return IndexList.ofArray(sorted);
  }
  sortWith(compare: (a: T, b: T) => number): IndexList<T> {
    return IndexList.ofArray(this.toList().slice().sort(compare));
  }
  sort(): IndexList<T> {
    return this.sortBy((x) => x);
  }
  sortDescending(): IndexList<T> {
    return this.sortByDescending((x) => x);
  }

  /** Maps each element to a list and concatenates. */
  collect<U>(mapping: (t: T) => IndexList<U>): IndexList<U> {
    let out = IndexList.empty<U>();
    this.iter((_i, v) => {
      for (const u of mapping(v)) out = out.add(u);
    });
    return out;
  }

  /** Numeric sum. */
  sum(this: IndexList<number>): number {
    let s = 0;
    for (const v of this) s += v;
    return s;
  }
  sumBy<U extends number>(mapping: (t: T) => U): number {
    let s = 0;
    for (const v of this) s += mapping(v) as number;
    return s;
  }
  average(this: IndexList<number>): number {
    if (this.count === 0) throw new Error("IndexList.average: empty list");
    let s = 0;
    for (const v of this) s += v;
    return s / this.count;
  }
  averageBy<U extends number>(mapping: (t: T) => U): number {
    if (this.count === 0) throw new Error("IndexList.averageBy: empty list");
    let s = 0;
    for (const v of this) s += mapping(v) as number;
    return s / this.count;
  }

  /** Splits a list of pairs into two lists. */
  static unzip<A, B>(l: IndexList<readonly [A, B]>): [IndexList<A>, IndexList<B>] {
    return [l.map((_i, p) => p[0]), l.map((_i, p) => p[1])];
  }

  /** Splits a list of triples into three lists. */
  static unzip3<A, B, C>(
    l: IndexList<readonly [A, B, C]>,
  ): [IndexList<A>, IndexList<B>, IndexList<C>] {
    return [
      l.map((_i, p) => p[0]),
      l.map((_i, p) => p[1]),
      l.map((_i, p) => p[2]),
    ];
  }

  /**
   * Structural equality on values, ignoring identity of Index keys.
   * (Two IndexLists holding the same values at the same positions
   * compare equal even if their Indices differ.)
   */
  equalsByValues(other: IndexList<T>): boolean {
    if (this.count !== other.count) return false;
    const a = this.toList();
    const b = other.toList();
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Module surface mirroring F# `module IndexList`.
// ---------------------------------------------------------------------------

export const IndexListOps = {
  empty: <T>() => IndexList.empty<T>(),
  single: <T>(v: T) => IndexList.single(v),
  ofSeq: <T>(s: Iterable<T>) => IndexList.ofSeq(s),
  ofArray: <T>(a: T[]) => IndexList.ofArray(a),
  ofList: <T>(a: T[]) => IndexList.ofList(a),
  range: (lo: number, hi: number) => IndexList.range(lo, hi),
  init: <T>(n: number, f: (i: number) => T) => IndexList.init(n, f),
  unzip: <A, B>(l: IndexList<readonly [A, B]>) => IndexList.unzip(l),
  unzip3: <A, B, C>(l: IndexList<readonly [A, B, C]>) => IndexList.unzip3(l),
  rev: <T>(l: IndexList<T>) => l.rev(),
  sub: <T>(o: number, c: number, l: IndexList<T>) => l.sub(o, c),
  collect: <T, U>(f: (t: T) => IndexList<U>, l: IndexList<T>) => l.collect(f),
  sortBy: <T, U>(f: (t: T) => U, l: IndexList<T>) => l.sortBy(f),
  sortByDescending: <T, U>(f: (t: T) => U, l: IndexList<T>) => l.sortByDescending(f),
  sortWith: <T>(cmp: (a: T, b: T) => number, l: IndexList<T>) => l.sortWith(cmp),
  sort: <T>(l: IndexList<T>) => l.sort(),
  sortDescending: <T>(l: IndexList<T>) => l.sortDescending(),
  sum: (l: IndexList<number>) => l.sum(),
  sumBy: <T, U extends number>(f: (t: T) => U, l: IndexList<T>) => l.sumBy(f),
  average: (l: IndexList<number>) => l.average(),
  averageBy: <T, U extends number>(f: (t: T) => U, l: IndexList<T>) => l.averageBy(f),
  tryGetPositionByIndex: <T>(idx: Index, l: IndexList<T>) => l.tryGetPosition(idx),
  count: <T>(l: IndexList<T>) => l.count,
  isEmpty: <T>(l: IndexList<T>) => l.isEmpty,
  add: <T>(v: T, l: IndexList<T>) => l.add(v),
  prepend: <T>(v: T, l: IndexList<T>) => l.prepend(v),
  set: <T>(idx: Index, v: T, l: IndexList<T>) => l.setByIndex(idx, v),
  setAt: <T>(i: number, v: T, l: IndexList<T>) => l.setByPosition(i, v),
  insertAt: <T>(i: number, v: T, l: IndexList<T>) => l.insertAt(i, v),
  remove: <T>(idx: Index, l: IndexList<T>) => l.removeByIndex(idx),
  removeAt: <T>(i: number, l: IndexList<T>) => l.removeAt(i),
  tryGet: <T>(idx: Index, l: IndexList<T>) => l.tryGetByIndex(idx),
  tryGetByPosition: <T>(i: number, l: IndexList<T>) => l.tryGetByPosition(i),
  map: <T, U>(f: (i: Index, t: T) => U, l: IndexList<T>) => l.map(f),
  choose: <T, U>(f: (i: Index, t: T) => U | undefined, l: IndexList<T>) =>
    l.choose(f),
  filter: <T>(p: (i: Index, t: T) => boolean, l: IndexList<T>) => l.filter(p),
  partition: <T>(p: (i: Index, t: T) => boolean, l: IndexList<T>) =>
    l.partition(p),
  iter: <T>(action: (i: Index, t: T) => void, l: IndexList<T>) => l.iter(action),
  fold: <T, S>(folder: (s: S, i: Index, t: T) => S, state: S, l: IndexList<T>) =>
    l.fold(folder, state),
  toSeq: <T>(l: IndexList<T>): Iterable<T> => l,
  toList: <T>(l: IndexList<T>) => l.toList(),
  toArray: <T>(l: IndexList<T>) => l.toArray(),
  toSeqIndexed: <T>(l: IndexList<T>) => l.toSeqIndexed(),
  toListIndexed: <T>(l: IndexList<T>) => l.toListIndexed(),
  toArrayIndexed: <T>(l: IndexList<T>) => l.toArrayIndexed(),
  take: <T>(n: number, l: IndexList<T>) => l.takeFirst(n),
  skip: <T>(n: number, l: IndexList<T>) => l.skipFirst(n),
  append: <T>(a: IndexList<T>, b: IndexList<T>) => IndexList.append(a, b),
  ofMap: <T>(content: MapExt<Index, T>) => IndexList.fromMap(content),
};
