// Port of FSharp.Data.Adaptive AdaptiveIndexList/AdaptiveIndexList.fs
//
// PORT NOTE: structurally mirrors adaptiveHashSet.ts /
// adaptiveHashMap.ts. Skipped F# operations marked below; can be
// added incrementally:
//   * `mapUse` / `mapUsei` — needs IDisposable
//   * `range` / `init` — generic numeric arithmetic; can specialise
//     for `number` if needed
//   * `subA` / `sub` / `take` / `skip` / `takeA` / `skipA` —
//     `SubReader` is the most intricate F# reader (range slicing
//     with overlapping windows). Deferred to a follow-up.

import {
  AbstractVal,
  AVal,
  type aval,
  delay as avalDelay,
  constant as avalConstant,
} from "../adaptiveValue/adaptiveValue.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import type { IAdaptiveObject } from "../core/types.js";
import { Index, indexZero } from "../datastructures/index.js";
import { MapExt } from "../datastructures/mapExt.js";
import { IndexList } from "../datastructures/indexList.js";
import {
  IndexListDelta,
  IndexListDeltaExt,
} from "../datastructures/indexListDelta.js";
import {
  type ElementOperation,
  ElementSet,
  ElementRemove,
} from "../datastructures/operations.js";
import { MultiSetMap } from "../datastructures/multiSetMap.js";
import { IndexCache } from "../utilities/indexCache.js";
import { IndexMapping, type Compare } from "../utilities/indexMapping.js";
import { HashTable } from "../utilities/hashTable.js";
import { rangeChange } from "../utilities/rangeDelta.js";
import { indexListTrace } from "../traceable/indexListTraceable.js";
import {
  AbstractDirtyReader,
  AbstractReader,
  AbstractStatefulReader,
  ConstantReader,
  EmptyReader,
  History,
  type IOpReader,
  type IOpReaderWithState,
} from "../traceable/history.js";
import type { AdaptiveReduction } from "../adaptiveValue/adaptiveReduction.js";
import * as Reductions from "../adaptiveValue/adaptiveReduction.js";

// Shared tag predicates — one closure per module, not per reader.
const _tagNotInput = (tag: unknown): boolean => tag !== "input";
const _tagIsInnerreader = (tag: unknown): boolean => tag === "InnerReader";
const _tagIsMultireader = (tag: unknown): boolean => tag === "MultiReader";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IIndexListReader<T> = IOpReaderWithState<
  IndexList<T>,
  IndexListDelta<T>
>;

export interface alist<T> {
  readonly isConstant: boolean;
  readonly content: aval<IndexList<T>>;
  getReader(): IIndexListReader<T>;
  readonly history: History<IndexList<T>, IndexListDelta<T>> | undefined;

  // transforms
  mapi<R>(mapping: (i: Index, t: T) => R): alist<R>;
  map<R>(mapping: (t: T) => R): alist<R>;
  choosei<R>(mapping: (i: Index, t: T) => R | undefined): alist<R>;
  choose<R>(mapping: (t: T) => R | undefined): alist<R>;
  filteri(predicate: (i: Index, t: T) => boolean): alist<T>;
  filter(predicate: (t: T) => boolean): alist<T>;
  mapAi<R>(mapping: (i: Index, t: T) => aval<R>): alist<R>;
  mapA<R>(mapping: (t: T) => aval<R>): alist<R>;
  chooseAi<R>(mapping: (i: Index, t: T) => aval<R | undefined>): alist<R>;
  chooseA<R>(mapping: (t: T) => aval<R | undefined>): alist<R>;
  filterAi(predicate: (i: Index, t: T) => aval<boolean>): alist<T>;
  filterA(predicate: (t: T) => aval<boolean>): alist<T>;
  collecti<R>(mapping: (i: Index, t: T) => alist<R>): alist<R>;
  collect<R>(mapping: (t: T) => alist<R>): alist<R>;
  collectSeq<R>(mapping: (t: T) => Iterable<R>): alist<R>;
  indexed(): alist<[Index, T]>;
  append(other: alist<T>): alist<T>;
  sortByi<K>(mapping: (i: Index, t: T) => K, compare?: (a: K, b: K) => number): alist<T>;
  sortBy<K>(mapping: (t: T) => K, compare?: (a: K, b: K) => number): alist<T>;
  sortWith(compare: (a: T, b: T) => number): alist<T>;
  sort(): alist<T>;
  sortDescending(): alist<T>;
  rev(): alist<T>;
  subA(offset: aval<number>, count: aval<number>): alist<T>;
  sub(offset: number, count: number): alist<T>;
  take(count: number): alist<T>;
  takeA(count: aval<number>): alist<T>;
  skip(count: number): alist<T>;
  skipA(count: aval<number>): alist<T>;
  pairwise(): alist<[T, T]>;
  pairwiseCyclic(): alist<[T, T]>;
  // queries returning aval
  tryGet(index: Index): aval<T | undefined>;
  tryAt(pos: number): aval<T | undefined>;
  tryFirst(): aval<T | undefined>;
  tryLast(): aval<T | undefined>;
  isEmpty(): aval<boolean>;
  count(): aval<number>;
  reduce<S, V>(reduction: AdaptiveReduction<T, S, V>): aval<V>;
  reduceBy<T2, S, V>(reduction: AdaptiveReduction<T2, S, V>, mapping: (t: T) => T2): aval<V>;
  reduceByA<B, S, V>(reduction: AdaptiveReduction<B, S, V>, mapping: (t: T) => aval<B>): aval<V>;
  fold<S>(add: (s: S, v: T) => S, zero: S): aval<S>;
  foldGroup<S>(add: (s: S, v: T) => S, subtract: (s: S, v: T) => S, zero: S): aval<S>;
  foldHalfGroup<S>(add: (s: S, v: T) => S, trySubtract: (s: S, v: T) => S | undefined, zero: S): aval<S>;
  forall(predicate: (t: T) => boolean): aval<boolean>;
  exists(predicate: (t: T) => boolean): aval<boolean>;
  forallA(predicate: (t: T) => aval<boolean>): aval<boolean>;
  existsA(predicate: (t: T) => aval<boolean>): aval<boolean>;
  countBy(predicate: (t: T) => boolean): aval<number>;
  countByA(predicate: (t: T) => aval<boolean>): aval<number>;
  sumBy(mapping: (t: T) => number): aval<number>;
  sumByA(mapping: (t: T) => aval<number>): aval<number>;
  averageBy(mapping: (t: T) => number): aval<number>;
  averageByA(mapping: (t: T) => aval<number>): aval<number>;
  tryMin(compare?: (a: T, b: T) => number): aval<T | undefined>;
  tryMax(compare?: (a: T, b: T) => number): aval<T | undefined>;
  toAVal(): aval<IndexList<T>>;
  force(): IndexList<T>;
}

export function force<T>(list: alist<T>): IndexList<T> {
  return AVal.force(list.content);
}

export abstract class AbstractAlist<T> implements alist<T> {
  abstract readonly isConstant: boolean;
  abstract readonly content: aval<IndexList<T>>;
  abstract readonly history: History<IndexList<T>, IndexListDelta<T>> | undefined;
  abstract getReader(): IIndexListReader<T>;

  mapi<R>(mapping: (i: Index, t: T) => R): alist<R> { return mapi(mapping, this); }
  map<R>(mapping: (t: T) => R): alist<R> { return map(mapping, this); }
  choosei<R>(mapping: (i: Index, t: T) => R | undefined): alist<R> { return choosei(mapping, this); }
  choose<R>(mapping: (t: T) => R | undefined): alist<R> { return choose(mapping, this); }
  filteri(predicate: (i: Index, t: T) => boolean): alist<T> { return filteri(predicate, this); }
  filter(predicate: (t: T) => boolean): alist<T> { return filter(predicate, this); }
  mapAi<R>(mapping: (i: Index, t: T) => aval<R>): alist<R> { return mapAi(mapping, this); }
  mapA<R>(mapping: (t: T) => aval<R>): alist<R> { return mapA(mapping, this); }
  chooseAi<R>(mapping: (i: Index, t: T) => aval<R | undefined>): alist<R> { return chooseAi(mapping, this); }
  chooseA<R>(mapping: (t: T) => aval<R | undefined>): alist<R> { return chooseA(mapping, this); }
  filterAi(predicate: (i: Index, t: T) => aval<boolean>): alist<T> { return filterAi(predicate, this); }
  filterA(predicate: (t: T) => aval<boolean>): alist<T> { return filterA(predicate, this); }
  collecti<R>(mapping: (i: Index, t: T) => alist<R>): alist<R> { return collecti(mapping, this); }
  collect<R>(mapping: (t: T) => alist<R>): alist<R> { return collect(mapping, this); }
  collectSeq<R>(mapping: (t: T) => Iterable<R>): alist<R> { return collectSeq(mapping, this); }
  indexed(): alist<[Index, T]> { return indexed(this); }
  append(other: alist<T>): alist<T> { return append(this, other); }
  sortByi<K>(mapping: (i: Index, t: T) => K, compare?: (a: K, b: K) => number): alist<T> { return sortByi(mapping, this, compare); }
  sortBy<K>(mapping: (t: T) => K, compare?: (a: K, b: K) => number): alist<T> { return sortBy(mapping, this, compare); }
  sortWith(compare: (a: T, b: T) => number): alist<T> { return sortWith(compare, this); }
  sort(): alist<T> { return sort(this); }
  sortDescending(): alist<T> { return sortDescending(this); }
  rev(): alist<T> { return rev(this); }
  subA(offset: aval<number>, count: aval<number>): alist<T> { return subA(offset, count, this); }
  sub(offset: number, count: number): alist<T> { return sub(offset, count, this); }
  take(count: number): alist<T> { return take(count, this); }
  takeA(count: aval<number>): alist<T> { return takeA(count, this); }
  skip(count: number): alist<T> { return skip(count, this); }
  skipA(count: aval<number>): alist<T> { return skipA(count, this); }
  pairwise(): alist<[T, T]> { return pairwise(this); }
  pairwiseCyclic(): alist<[T, T]> { return pairwiseCyclic(this); }
  tryGet(index: Index): aval<T | undefined> { return tryGet(index, this); }
  tryAt(pos: number): aval<T | undefined> { return tryAt(pos, this); }
  tryFirst(): aval<T | undefined> { return tryFirst(this); }
  tryLast(): aval<T | undefined> { return tryLast(this); }
  isEmpty(): aval<boolean> { return isEmpty(this); }
  count(): aval<number> { return count(this); }
  reduce<S, V>(reduction: AdaptiveReduction<T, S, V>): aval<V> { return reduce(reduction, this); }
  reduceBy<T2, S, V>(reduction: AdaptiveReduction<T2, S, V>, mapping: (t: T) => T2): aval<V> { return reduceBy(reduction, (_i, v) => mapping(v), this); }
  reduceByA<B, S, V>(reduction: AdaptiveReduction<B, S, V>, mapping: (t: T) => aval<B>): aval<V> { return reduceByA(reduction, (_i, v) => mapping(v), this); }
  fold<S>(add: (s: S, v: T) => S, zero: S): aval<S> { return fold(add, zero, this); }
  foldGroup<S>(add: (s: S, v: T) => S, subtract: (s: S, v: T) => S, zero: S): aval<S> { return foldGroup(add, subtract, zero, this); }
  foldHalfGroup<S>(add: (s: S, v: T) => S, trySubtract: (s: S, v: T) => S | undefined, zero: S): aval<S> { return foldHalfGroup(add, trySubtract, zero, this); }
  forall(predicate: (t: T) => boolean): aval<boolean> { return forall(predicate, this); }
  exists(predicate: (t: T) => boolean): aval<boolean> { return exists(predicate, this); }
  forallA(predicate: (t: T) => aval<boolean>): aval<boolean> { return forallA(predicate, this); }
  existsA(predicate: (t: T) => aval<boolean>): aval<boolean> { return existsA(predicate, this); }
  countBy(predicate: (t: T) => boolean): aval<number> { return countBy(predicate, this); }
  countByA(predicate: (t: T) => aval<boolean>): aval<number> { return countByA(predicate, this); }
  sumBy(mapping: (t: T) => number): aval<number> { return sumBy(mapping, this); }
  sumByA(mapping: (t: T) => aval<number>): aval<number> { return sumByA(mapping, this); }
  averageBy(mapping: (t: T) => number): aval<number> { return averageBy(mapping, this); }
  averageByA(mapping: (t: T) => aval<number>): aval<number> { return averageByA(mapping, this); }
  tryMin(compare?: (a: T, b: T) => number): aval<T | undefined> { return tryMin(this, compare); }
  tryMax(compare?: (a: T, b: T) => number): aval<T | undefined> { return tryMax(this, compare); }
  toAVal(): aval<IndexList<T>> { return toAVal(this); }
  force(): IndexList<T> { return force(this); }
}

// ---------------------------------------------------------------------------
// Empty / Constant / Impl
// ---------------------------------------------------------------------------

class EmptyList<T> extends AbstractAlist<T> {
  override readonly isConstant = true;
  override readonly content: aval<IndexList<T>> = avalConstant(IndexList.empty<T>());
  override readonly history = undefined;
  private static _cached: EmptyList<unknown> | null = null;
  static instance<T>(): alist<T> {
    if (!EmptyList._cached) EmptyList._cached = new EmptyList<unknown>();
    return EmptyList._cached as unknown as alist<T>;
  }
  override getReader(): IIndexListReader<T> {
    return new EmptyReader<IndexList<T>, IndexListDelta<T>>(indexListTrace<T>());
  }
}

class ConstantList<T> extends AbstractAlist<T> {
  override readonly isConstant = true;
  private readonly _create: () => IndexList<T>;
  private _cached: IndexList<T> | null = null;
  override readonly content: aval<IndexList<T>>;
  override readonly history = undefined;
  constructor(create: () => IndexList<T>) {
    super();
    this._create = create;
    this.content = avalDelay(() => this.lazy());
  }
  private lazy(): IndexList<T> {
    if (this._cached === null) this._cached = this._create();
    return this._cached;
  }
  override getReader(): IIndexListReader<T> {
    return new ConstantReader<IndexList<T>, IndexListDelta<T>>(
      indexListTrace<T>(),
      () =>
        IndexListDeltaExt.computeDelta<T>(IndexList.empty<T>(), this.lazy()),
      () => this.lazy(),
    );
  }
}

class AdaptiveIndexListImpl<T> extends AbstractAlist<T> {
  override readonly isConstant = false;
  override readonly history: History<IndexList<T>, IndexListDelta<T>>;
  override readonly content: aval<IndexList<T>>;
  constructor(createReader: () => IOpReader<IndexListDelta<T>>) {
    super();
    this.history = History.ofReader<IndexList<T>, IndexListDelta<T>>(
      indexListTrace<T>(),
      createReader,
    );
    this.content = AVal.custom((tok) => {
      this.history.getValue(tok);
      return this.history.state;
    });
  }
  override getReader(): IIndexListReader<T> {
    return this.history.newReader();
  }
}

function constant<T>(create: () => IndexList<T>): alist<T> {
  return new ConstantList<T>(create);
}

function ofReaderInternal<T>(
  createReader: () => IOpReader<IndexListDelta<T>>,
): alist<T> {
  return new AdaptiveIndexListImpl<T>(createReader);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Reader for `init` (`alist<T>` of length `aval<number>` with element
 * `(i: number) => T`).
 */
class InitReader<T> extends AbstractReader<IndexListDelta<T>> {
  private readonly _input: aval<number>;
  private readonly _mapping: (i: number) => T;
  private _lastLength = 0;
  // Track allocated indices in insertion order so we can pop the last
  // on a length decrease.
  private _idxs: IndexList<true> = IndexList.empty<true>();
  constructor(input: aval<number>, mapping: (i: number) => T) {
    super(IndexListDelta.empty<T>());
    this._input = input;
    this._mapping = mapping;
  }
  override compute(tok: AdaptiveToken): IndexListDelta<T> {
    const newLength = Math.max(0, this._input.getValue(tok) | 0);
    let delta = IndexListDelta.empty<T>();
    // length increase
    for (let i = this._lastLength; i < newLength; i++) {
      this._idxs = this._idxs.add(true);
      const idx = this._idxs.maxIndex;
      delta = delta.add(idx, ElementSet(this._mapping(i)));
    }
    // length decrease
    for (let i = this._lastLength - 1; i >= newLength; i--) {
      const idx = this._idxs.maxIndex;
      delta = delta.add(idx, ElementRemove);
      this._idxs = this._idxs.removeByIndex(idx);
    }
    this._lastLength = newLength;
    return delta;
  }
}

/**
 * Reader for `range` over `number`. Faithful port of F#'s AList.range
 * reader: emits a minimal four-region delta as the bounds shift.
 * Uses `RangeDelta.rangeChange` to split the change into max-side
 * increase / decrease and min-side decrease / increase, then
 * applies them in the F#-specified order so that intermediate
 * `idxs` state stays consistent with the `lastMin`/`lastMax`
 * bookkeeping.
 */
class RangeReader extends AbstractReader<IndexListDelta<number>> {
  private readonly _lower: aval<number>;
  private readonly _upper: aval<number>;
  // Convention: lastMax = -1, lastMin = 0 ⇒ range currently empty.
  private _lastMin = 0;
  private _lastMax = -1;
  // Holds one entry per current range value, in ascending order.
  // We carry payload `true` and observe positions via
  // `idxs.minIndex` / `idxs.maxIndex`.
  private _idxs: IndexList<true> = IndexList.empty<true>();
  constructor(lower: aval<number>, upper: aval<number>) {
    super(IndexListDelta.empty<number>());
    this._lower = lower;
    this._upper = upper;
  }
  override compute(tok: AdaptiveToken): IndexListDelta<number> {
    const newMin = this._lower.getValue(tok) | 0;
    const newMax = this._upper.getValue(tok) | 0;

    const r = rangeChange(this._lastMin, this._lastMax, newMin, newMax);
    let delta = IndexListDelta.empty<number>();

    // Count up through additions caused by increasing maximum.
    for (let i = r.maxIncrease[0]; i <= r.maxIncrease[1]; i++) {
      this._idxs = this._idxs.add(true);
      delta = delta.add(this._idxs.maxIndex, ElementSet(i));
    }

    // Count down through removals caused by decreasing maximum.
    for (let i = r.maxDecrease[0]; i >= r.maxDecrease[1]; i--) {
      const lastMaxIdx = this._idxs.maxIndex;
      delta = delta.add(lastMaxIdx, ElementRemove);
      this._idxs = this._idxs.removeByIndex(lastMaxIdx);
    }

    // Count down through additions caused by decreasing minimum.
    for (let i = r.minDecrease[0]; i >= r.minDecrease[1]; i--) {
      this._idxs = this._idxs.prepend(true);
      delta = delta.add(this._idxs.minIndex, ElementSet(i));
    }

    // Count up through removals caused by increasing minimum.
    for (let i = r.minIncrease[0]; i <= r.minIncrease[1]; i++) {
      const lastMinIdx = this._idxs.minIndex;
      delta = delta.add(lastMinIdx, ElementRemove);
      this._idxs = this._idxs.removeByIndex(lastMinIdx);
    }

    this._lastMax = newMax;
    this._lastMin = newMin;
    return delta;
  }
}

/** Reader for `mapi` / `map`. */
class MapReader<A, B> extends AbstractReader<IndexListDelta<B>> {
  private readonly _reader: IIndexListReader<A>;
  private readonly _mapping: (i: Index, a: A) => B;
  constructor(input: alist<A>, mapping: (i: Index, a: A) => B) {
    super(IndexListDelta.empty<B>());
    this._reader = input.getReader();
    this._mapping = mapping;
  }
  static deltaMapping<A, B>(
    mapping: (i: Index, a: A) => B,
  ): (state: IndexList<A>, ops: IndexListDelta<A>) => IndexListDelta<B> {
    return (_state, ops) =>
      ops.map<B>((i, op) =>
        op.tag === "Set" ? ElementSet(mapping(i, op.value)) : ElementRemove,
      );
  }
  override compute(tok: AdaptiveToken): IndexListDelta<B> {
    return this._reader.getChanges(tok).map<B>((i, op) =>
      op.tag === "Set" ? ElementSet(this._mapping(i, op.value)) : ElementRemove,
    );
  }
}

/** Reader for `choosei` / `choose`. */
class ChooseReader<A, B> extends AbstractReader<IndexListDelta<B>> {
  private readonly _reader: IIndexListReader<A>;
  private readonly _cache: IndexCache<A, B | undefined>;
  constructor(input: alist<A>, mapping: (i: Index, a: A) => B | undefined) {
    super(IndexListDelta.empty<B>());
    this._reader = input.getReader();
    this._cache = new IndexCache<A, B | undefined>(mapping);
  }
  override compute(tok: AdaptiveToken): IndexListDelta<B> {
    return this._reader.getChanges(tok).choose<B>((i, op) => {
      if (op.tag === "Remove") {
        const v = this._cache.revoke(i);
        return v !== undefined ? ElementRemove : undefined;
      }
      const r = this._cache.invokeAndGetOld(i, op.value);
      if (r.newValue !== undefined) return ElementSet(r.newValue);
      // mapping returned undefined; remove if it was previously living
      if (r.oldValue !== undefined) return ElementRemove;
      return undefined;
    });
  }
}

/** Reader for `filteri` / `filter`. */
class FilterReader<A> extends AbstractReader<IndexListDelta<A>> {
  private readonly _reader: IIndexListReader<A>;
  private readonly _cache: IndexCache<A, boolean>;
  constructor(input: alist<A>, predicate: (i: Index, a: A) => boolean) {
    super(IndexListDelta.empty<A>());
    this._reader = input.getReader();
    this._cache = new IndexCache<A, boolean>(predicate);
  }
  override compute(tok: AdaptiveToken): IndexListDelta<A> {
    return this._reader.getChanges(tok).choose<A>((i, op) => {
      if (op.tag === "Remove") {
        const v = this._cache.revoke(i);
        return v === true ? ElementRemove : undefined;
      }
      const r = this._cache.invokeAndGetOld(i, op.value);
      if (r.newValue) return ElementSet(op.value);
      // false now: remove if was true
      if (r.oldValue === true) return ElementRemove;
      return undefined;
    });
  }
}

/** Reader for `mapAi` / `mapA`. Incremental, MultiSetMap-tracked. */
class MapAReader<A, B>
  extends AbstractDirtyReader<aval<B>, IndexListDelta<B>>
{
  private readonly _reader: IIndexListReader<A>;
  private readonly _mapping: (i: Index, a: A) => aval<B>;
  // per-index entry: input, aval, lastValue
  private _entries: HashTable<Index, [A, aval<B>]> = new HashTable();
  private _targets: MultiSetMap<aval<B>, Index> = MultiSetMap.empty<
    aval<B>,
    Index
  >();
  constructor(input: alist<A>, mapping: (i: Index, a: A) => aval<B>) {
    super({ mempty: IndexListDelta.empty<B>() }, _tagNotInput);
    this._reader = input.getReader();
    (this._reader as unknown as IAdaptiveObject).tag = "input";
    this._mapping = mapping;
  }
  private dropEntry(i: Index): void {
    const e = this._entries.get(i);
    if (e === undefined) return;
    const [, av] = e;
    this._entries.delete(i);
    const r = MultiSetMap.remove(av, i, this._targets);
    this._targets = r.result;
    if (r.wasLast) (av as unknown as IAdaptiveObject).outputs.remove(this);
  }
  override compute(
    tok: AdaptiveToken,
    dirty: Set<aval<B>>,
  ): IndexListDelta<B> {
    let out = IndexListDelta.empty<B>();
    const ops = this._reader.getChanges(tok);
    for (const [i, op] of ops) {
      if (op.tag === "Set") {
        const old = this._entries.get(i);
        if (old !== undefined) this.dropEntry(i);
        const m = this._mapping(i, op.value);
        const v = m.getValue(tok);
        this._targets = MultiSetMap.add(m, i, this._targets);
        this._entries.set(i, [op.value, m]);
        out = out.add(i, ElementSet(v));
      } else {
        if (this._entries.has(i)) {
          this.dropEntry(i);
          out = out.add(i, ElementRemove);
        }
      }
    }
    for (const d of dirty) {
      const indices = MultiSetMap.find(d, this._targets);
      for (const i of indices) {
        if (this._entries.has(i)) {
          // skip if structural op already dispatched for i
          const v = d.getValue(tok);
          out = out.add(i, ElementSet(v));
        }
      }
    }
    return out;
  }
}

/** Reader for `chooseAi` / `chooseA`. */
class ChooseAReader<A, B>
  extends AbstractDirtyReader<aval<B | undefined>, IndexListDelta<B>>
{
  private readonly _reader: IIndexListReader<A>;
  private readonly _mapping: (i: Index, a: A) => aval<B | undefined>;
  private _entries: HashTable<Index, [A, aval<B | undefined>]> =
    new HashTable();
  private _living: HashTable<Index, true> = new HashTable();
  private _targets: MultiSetMap<aval<B | undefined>, Index> = MultiSetMap.empty<
    aval<B | undefined>,
    Index
  >();
  constructor(input: alist<A>, mapping: (i: Index, a: A) => aval<B | undefined>) {
    super({ mempty: IndexListDelta.empty<B>() }, _tagNotInput);
    this._reader = input.getReader();
    (this._reader as unknown as IAdaptiveObject).tag = "input";
    this._mapping = mapping;
  }
  private dropEntry(i: Index): void {
    const e = this._entries.get(i);
    if (e === undefined) return;
    const [, av] = e;
    this._entries.delete(i);
    const r = MultiSetMap.remove(av, i, this._targets);
    this._targets = r.result;
    if (r.wasLast) (av as unknown as IAdaptiveObject).outputs.remove(this);
  }
  override compute(
    tok: AdaptiveToken,
    dirty: Set<aval<B | undefined>>,
  ): IndexListDelta<B> {
    let out = IndexListDelta.empty<B>();
    const ops = this._reader.getChanges(tok);
    for (const [i, op] of ops) {
      if (op.tag === "Set") {
        if (this._entries.has(i)) this.dropEntry(i);
        const m = this._mapping(i, op.value);
        const v = m.getValue(tok);
        this._targets = MultiSetMap.add(m, i, this._targets);
        this._entries.set(i, [op.value, m]);
        if (v !== undefined) {
          this._living.set(i, true);
          out = out.add(i, ElementSet(v));
        } else if (this._living.delete(i)) {
          out = out.add(i, ElementRemove);
        }
      } else {
        if (this._entries.has(i)) {
          this.dropEntry(i);
          if (this._living.delete(i)) out = out.add(i, ElementRemove);
        }
      }
    }
    for (const d of dirty) {
      const indices = MultiSetMap.find(d, this._targets);
      for (const i of indices) {
        if (this._entries.has(i)) {
          const v = d.getValue(tok);
          if (v !== undefined) {
            this._living.set(i, true);
            out = out.add(i, ElementSet(v));
          } else if (this._living.delete(i)) {
            out = out.add(i, ElementRemove);
          }
        }
      }
    }
    return out;
  }
}

// Compare for [Index, Index] pairs (lexicographic).
const indexPairCmp: Compare<[Index, Index]> = ([a1, a2], [b1, b2]) => {
  const c = a1.compareTo(b1);
  return c !== 0 ? c : a2.compareTo(b2);
};

/**
 * Inner reader used by collect/concat. Tracks one outer index `oi`
 * and produces deltas for that outer slot, mapping inner indices
 * through the shared `mapping`.
 */
class IndexedReader<A> extends AbstractReader<IndexListDelta<A>> {
  private readonly _mapping: IndexMapping<[Index, Index]>;
  private readonly _index: Index;
  private readonly _reader: IIndexListReader<A>;
  constructor(
    mapping: IndexMapping<[Index, Index]>,
    index: Index,
    input: alist<A>,
  ) {
    super(IndexListDelta.empty<A>());
    this._mapping = mapping;
    this._index = index;
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): IndexListDelta<A> {
    return this._reader.getChanges(tok).chooseIndexed<A>((i, op) => {
      if (op.tag === "Set") {
        const out = this._mapping.invoke([this._index, i]);
        return [out, ElementSet(op.value)];
      }
      const out = this._mapping.revoke([this._index, i]);
      if (out !== undefined) return [out, ElementRemove];
      return undefined;
    });
  }
}

/** Reader for `concat` / `append`. */
class ConcatReader<A> extends AbstractDirtyReader<
  IndexedReader<A>,
  IndexListDelta<A>
> {
  private readonly _readers: ReadonlyArray<IndexedReader<A>>;
  private _initial = true;
  constructor(inputs: IndexList<alist<A>>) {
    super(
      { mempty: IndexListDelta.empty<A>() },
      _tagIsInnerreader,
    );
    const mapping = new IndexMapping<[Index, Index]>(indexPairCmp);
    const arr: IndexedReader<A>[] = [];
    for (const [i, l] of inputs.toListIndexed()) {
      const r = new IndexedReader<A>(mapping, i, l);
      (r as unknown as IAdaptiveObject).tag = "InnerReader";
      arr.push(r);
    }
    this._readers = arr;
  }
  override compute(
    tok: AdaptiveToken,
    dirty: Set<IndexedReader<A>>,
  ): IndexListDelta<A> {
    if (this._initial) {
      this._initial = false;
      let out = IndexListDelta.empty<A>();
      for (const r of this._readers) out = out.combine(r.getChanges(tok));
      return out;
    }
    let out = IndexListDelta.empty<A>();
    for (const r of dirty) out = out.combine(r.getChanges(tok));
    return out;
  }
}

/**
 * Inner reader used by CollectReader. Holds one upstream alist and
 * the set of outer indices currently using it; emits deltas for each
 * `(outerIndex, innerIndex)` mapped to a fresh output Index.
 */
class MultiReader<A> extends AbstractReader<IndexListDelta<A>> {
  private readonly _mapping: IndexMapping<[Index, Index]>;
  private readonly _list: alist<A>;
  private readonly _release: (l: alist<A>) => void;
  private readonly _targets: HashTable<Index, true> = new HashTable();
  private _reader: IIndexListReader<A> | null = null;

  constructor(
    mapping: IndexMapping<[Index, Index]>,
    list: alist<A>,
    release: (l: alist<A>) => void,
  ) {
    super(IndexListDelta.empty<A>());
    this._mapping = mapping;
    this._list = list;
    this._release = release;
  }

  private getReader(): IIndexListReader<A> {
    if (this._reader === null) this._reader = this._list.getReader();
    return this._reader;
  }

  /**
   * Adds outer index `oi`. Returns the initial-content delta the
   * outer reader should observe for this slot.
   */
  addTarget(oi: Index): IndexListDelta<A> {
    if (this._targets.has(oi)) return IndexListDelta.empty<A>();
    this._targets.set(oi, true);
    const r = this.getReader();
    let out = IndexListDelta.empty<A>();
    for (const [ii, v] of r.state.toListIndexed()) {
      const oIdx = this._mapping.invoke([oi, ii]);
      out = out.add(oIdx, ElementSet(v));
    }
    return out;
  }

  removeTarget(
    dirty: Set<MultiReader<A>>,
    oi: Index,
  ): IndexListDelta<A> {
    if (!this._targets.delete(oi)) return IndexListDelta.empty<A>();
    let out = IndexListDelta.empty<A>();
    if (this._reader !== null) {
      for (const [ii] of this._reader.state.toListIndexed()) {
        const v = this._mapping.revoke([oi, ii]);
        if (v !== undefined) out = out.add(v, ElementRemove);
      }
    }
    if (this._targets.count === 0) {
      dirty.delete(this);
      this.release();
    }
    return out;
  }

  release(): void {
    if (this._reader !== null) {
      this._release(this._list);
      (this._reader as unknown as IAdaptiveObject).outputs.remove(this);
      this._reader = null;
    }
  }

  override compute(tok: AdaptiveToken): IndexListDelta<A> {
    if (this._reader === null) return IndexListDelta.empty<A>();
    const ops = this._reader.getChanges(tok);
    let out = IndexListDelta.empty<A>();
    for (const [ii, op] of ops) {
      for (const [oi] of this._targets) {
        if (op.tag === "Remove") {
          const v = this._mapping.revoke([oi, ii]);
          if (v !== undefined) out = out.add(v, ElementRemove);
        } else {
          const v = this._mapping.invoke([oi, ii]);
          out = out.add(v, ElementSet(op.value));
        }
      }
    }
    return out;
  }
}

/** Reader for `collecti` / `collect`. */
class CollectReader<A, B> extends AbstractDirtyReader<
  MultiReader<B>,
  IndexListDelta<B>
> {
  private readonly _input: IIndexListReader<A>;
  private readonly _mapping: (i: Index, a: A) => alist<B>;
  private readonly _indexMap: IndexMapping<[Index, Index]> = new IndexMapping<
    [Index, Index]
  >(indexPairCmp);
  // (i, a, alist) cache per outer index
  private readonly _cache: HashTable<Index, [A, alist<B>]> = new HashTable();
  // alist instance → MultiReader instance.
  private readonly _readers: Map<alist<B>, MultiReader<B>> = new Map();

  constructor(input: alist<A>, mapping: (i: Index, a: A) => alist<B>) {
    super(
      { mempty: IndexListDelta.empty<B>() },
      _tagIsMultireader,
    );
    this._input = input.getReader();
    this._mapping = mapping;
  }

  private getMultiReader(l: alist<B>): MultiReader<B> {
    let r = this._readers.get(l);
    if (r === undefined) {
      r = new MultiReader<B>(this._indexMap, l, (al) => this._readers.delete(al));
      (r as unknown as IAdaptiveObject).tag = "MultiReader";
      this._readers.set(l, r);
    }
    return r;
  }

  private invoke(
    dirty: Set<MultiReader<B>>,
    i: Index,
    v: A,
  ): IndexListDelta<B> {
    const old = this._cache.get(i);
    if (old !== undefined) {
      const [oldValue, oldList] = old;
      if (Object.is(oldValue, v)) {
        const r = this.getMultiReader(oldList);
        dirty.add(r);
        return IndexListDelta.empty<B>();
      }
      const newList = this._mapping(i, v);
      this._cache.set(i, [v, newList]);
      if (newList !== oldList) {
        const newReader = this.getMultiReader(newList);
        const oldReader = this._readers.get(oldList);
        const rem =
          oldReader !== undefined
            ? oldReader.removeTarget(dirty, i)
            : IndexListDelta.empty<B>();
        const add = newReader.addTarget(i);
        dirty.add(newReader);
        return rem.combine(add);
      }
      const r = this.getMultiReader(oldList);
      dirty.add(r);
      return IndexListDelta.empty<B>();
    }
    const newList = this._mapping(i, v);
    this._cache.set(i, [v, newList]);
    const newReader = this.getMultiReader(newList);
    const add = newReader.addTarget(i);
    dirty.add(newReader);
    return add;
  }

  private revoke(
    dirty: Set<MultiReader<B>>,
    i: Index,
  ): IndexListDelta<B> {
    const cur = this._cache.get(i);
    if (cur === undefined) return IndexListDelta.empty<B>();
    const [, l] = cur;
    const r = this.getMultiReader(l);
    this._cache.delete(i);
    return r.removeTarget(dirty, i);
  }

  override compute(
    tok: AdaptiveToken,
    dirty: Set<MultiReader<B>>,
  ): IndexListDelta<B> {
    let out = IndexListDelta.empty<B>();
    for (const [i, op] of this._input.getChanges(tok)) {
      if (op.tag === "Remove") out = out.combine(this.revoke(dirty, i));
      else out = out.combine(this.invoke(dirty, i, op.value));
    }
    for (const r of dirty) out = out.combine(r.getChanges(tok));
    return out;
  }
}

/** Reader for `bind`. */
class BindReader<A, B> extends AbstractReader<IndexListDelta<B>> {
  private readonly _value: aval<A>;
  private readonly _mapping: (a: A) => alist<B>;
  private _cur: { v: A; reader: IIndexListReader<B> } | null = null;
  constructor(value: aval<A>, mapping: (a: A) => alist<B>) {
    super(IndexListDelta.empty<B>());
    this._value = value;
    this._mapping = mapping;
  }
  override compute(tok: AdaptiveToken): IndexListDelta<B> {
    const v = this._value.getValue(tok);
    if (this._cur !== null && Object.is(this._cur.v, v)) {
      return this._cur.reader.getChanges(tok);
    }
    let rem = IndexListDelta.empty<B>();
    if (this._cur !== null) {
      const oldReader = this._cur.reader;
      rem = IndexListDeltaExt.computeDelta(
        oldReader.state,
        IndexList.empty<B>(),
      );
      (oldReader as unknown as IAdaptiveObject).outputs.remove(this);
    }
    const newList = this._mapping(v);
    const newReader = newList.getReader();
    this._cur = { v, reader: newReader };
    const add = newReader.getChanges(tok);
    return rem.combine(add);
  }
}

/** Reader for `ofAVal`. */
class AValReader<T> extends AbstractStatefulReader<
  IndexList<T>,
  IndexListDelta<T>
> {
  private readonly _input: aval<Iterable<T>>;
  constructor(input: aval<Iterable<T>>) {
    super(indexListTrace<T>());
    this._input = input;
  }
  override compute(tok: AdaptiveToken): IndexListDelta<T> {
    const seq = this._input.getValue(tok);
    const next =
      seq instanceof IndexList ? (seq as IndexList<T>) : IndexList.ofSeq(seq);
    return IndexListDeltaExt.computeDelta(this._state, next);
  }
}

/** Reader for `sortByi` / `sortBy`. */
class SortByReader<A, B> extends AbstractReader<IndexListDelta<A>> {
  private readonly _reader: IIndexListReader<A>;
  private readonly _mapping: (i: Index, a: A) => B;
  private readonly _idx: IndexMapping<[B, Index]>;
  private readonly _cache: HashTable<Index, B> = new HashTable();
  constructor(
    input: alist<A>,
    mapping: (i: Index, a: A) => B,
    compareKey?: (a: B, b: B) => number,
  ) {
    super(IndexListDelta.empty<A>());
    this._reader = input.getReader();
    this._mapping = mapping;
    const cmp =
      compareKey ??
      ((a: B, b: B) => (a < b ? -1 : a > b ? 1 : 0));
    this._idx = new IndexMapping<[B, Index]>(([la, li], [ra, ri]) => {
      const c = cmp(la, ra);
      if (c !== 0) return c;
      return li.compareTo(ri);
    });
  }
  override compute(tok: AdaptiveToken): IndexListDelta<A> {
    let out = IndexListDelta.empty<A>();
    for (const [i, op] of this._reader.getChanges(tok)) {
      if (op.tag === "Set") {
        const oldB = this._cache.get(i);
        if (oldB !== undefined) {
          const oi = this._idx.revoke([oldB, i]);
          if (oi !== undefined) out = out.add(oi, ElementRemove);
        }
        const b = this._mapping(i, op.value);
        this._cache.set(i, b);
        const oi = this._idx.invoke([b, i]);
        out = out.add(oi, ElementSet(op.value));
      } else {
        const oldB = this._cache.get(i);
        if (oldB !== undefined) {
          this._cache.delete(i);
          const oi = this._idx.revoke([oldB, i]);
          if (oi !== undefined) out = out.add(oi, ElementRemove);
        }
      }
    }
    return out;
  }
}

/** Reader for `sortWith`. */
class SortWithReader<A> extends AbstractReader<IndexListDelta<A>> {
  private readonly _reader: IIndexListReader<A>;
  private readonly _idx: IndexMapping<[A, Index]>;
  constructor(input: alist<A>, compare: (a: A, b: A) => number) {
    super(IndexListDelta.empty<A>());
    this._reader = input.getReader();
    this._idx = new IndexMapping<[A, Index]>(([la, li], [ra, ri]) => {
      const c = compare(la, ra);
      if (c !== 0) return c;
      return li.compareTo(ri);
    });
  }
  override compute(tok: AdaptiveToken): IndexListDelta<A> {
    let out = IndexListDelta.empty<A>();
    const old = this._reader.state;
    for (const [i, op] of this._reader.getChanges(tok)) {
      if (op.tag === "Set") {
        const ov = old.tryGetByIndex(i);
        if (ov !== undefined) {
          const oi = this._idx.revoke([ov, i]);
          if (oi !== undefined) out = out.add(oi, ElementRemove);
        }
        const oi = this._idx.invoke([op.value, i]);
        out = out.add(oi, ElementSet(op.value));
      } else {
        const ov = old.tryGetByIndex(i);
        if (ov !== undefined) {
          const oi = this._idx.revoke([ov, i]);
          if (oi !== undefined) out = out.add(oi, ElementRemove);
        }
      }
    }
    return out;
  }
}

/**
 * Reader for `subA` / `sub` / `take*` / `skip*`. Faithful port of
 * F#'s `SubReader`: maintains a sliced state map plus min/max
 * Index bookkeeping and emits a minimal four-region delta as the
 * window shifts. Output preserves upstream indices.
 *
 * The state is `MapExt<Index, T>` — values keyed by the upstream's
 * own indices, restricted to `[minIndex, maxIndex]` (inclusive).
 */
class SubReader<T> extends AbstractReader<IndexListDelta<T>> {
  private readonly _reader: IIndexListReader<T>;
  private readonly _offset: aval<number>;
  private readonly _count: aval<number>;
  // Current slice keyed by the upstream's Index. Empty when the
  // window is empty; non-empty otherwise with keys ⊆ [minIndex, maxIndex].
  private _state: MapExt<Index, T> = MapExt.empty<Index, T>(_indexCmp);
  // Inclusive lower / upper bounds. Convention when slice is empty:
  // both equal `Index.zero` (irrelevant; we check `_state.isEmpty`).
  private _minIndex: Index = indexZero;
  private _maxIndex: Index = indexZero;

  constructor(input: alist<T>, offset: aval<number>, count: aval<number>) {
    super(IndexListDelta.empty<T>());
    this._reader = input.getReader();
    this._offset = offset;
    this._count = count;
  }

  override compute(tok: AdaptiveToken): IndexListDelta<T> {
    const offset = this._offset.getValue(tok) | 0;
    const count = this._count.getValue(tok) | 0;
    const ops = this._reader.getChanges(tok);
    const up = this._reader.state;

    // Pick the new bounds. F# uses `TryGetIndexV` then falls back to
    // `Index.after MaxIndex` for an out-of-range lower bound.
    const lo = Math.max(0, offset);
    const hi = offset + count - 1;
    let newMin: Index;
    if (lo < up.count) {
      newMin = up.tryGetIndex(lo)!;
    } else {
      newMin = up.isEmpty ? indexZero.after() : up.maxIndex.after();
    }
    let newMax: Index;
    if (hi >= 0 && hi < up.count) {
      newMax = up.tryGetIndex(hi)!;
    } else if (hi >= up.count) {
      newMax = up.isEmpty ? indexZero : up.maxIndex;
    } else {
      // hi < 0 — empty window. Sentinel value below `newMin` makes
      // `newMax >= newMin` false, which the empty branch handles.
      newMax = indexZero;
    }

    const newWindowEmpty = up.isEmpty || newMax.compareTo(newMin) < 0;

    if (!newWindowEmpty) {
      // New window is non-empty.
      const stateEmpty = this._state.isEmpty;
      const disjoint =
        stateEmpty ||
        newMin.compareTo(this._maxIndex) > 0 ||
        newMax.compareTo(this._minIndex) < 0;
      if (disjoint) {
        const newState = up.content.slice(newMin, newMax);
        let delta = MapExt.empty<Index, ElementOperation<T>>(_indexCmp);
        if (!stateEmpty) {
          // Drop everything in old state.
          for (const [k] of this._state) delta = delta.add(k, ElementRemove);
        }
        // Add everything in new state.
        for (const [k, v] of newState) delta = delta.add(k, ElementSet(v));
        this._state = newState;
        this._minIndex = newMin;
        this._maxIndex = newMax;
        return IndexListDelta.ofMap(delta);
      }

      // Old and new windows overlap.
      const sharedMin =
        newMin.compareTo(this._minIndex) > 0 ? newMin : this._minIndex;
      const sharedMax =
        newMax.compareTo(this._maxIndex) < 0 ? newMax : this._maxIndex;

      // Apply just the inner-region delta to the existing state.
      const innerDelta = ops.content.slice(sharedMin, sharedMax);
      const innerResult = this._state.applyDeltaAndGetEffective<
        ElementOperation<T>,
        ElementOperation<T>
      >(innerDelta, applyForElementOp<T>);
      this._state = innerResult.state;
      let delta = innerResult.effective;

      // Extend / shrink the lower side.
      if (this._minIndex.compareTo(newMin) > 0) {
        // window grew on the lower side: pull entries `[newMin, minIndex)`.
        const l = up.content.sliceEx(newMin, true, this._minIndex, false);
        for (const [k, v] of l) delta = delta.add(k, ElementSet(v));
        this._state = this._state.union(l);
        this._minIndex = newMin;
      } else if (this._minIndex.compareTo(newMin) < 0) {
        // window shrank on the lower side: drop entries `[minIndex, newMin)`.
        const split = this._state.split(newMin);
        this._state = split.hasValue
          ? split.right.add(newMin, split.self as T)
          : split.right;
        for (const [k] of split.left) delta = delta.add(k, ElementRemove);
        this._minIndex = newMin;
      }

      // Extend / shrink the upper side.
      if (this._maxIndex.compareTo(newMax) < 0) {
        // window grew on the upper side: pull entries `(maxIndex, newMax]`.
        const r = up.content.sliceEx(this._maxIndex, false, newMax, true);
        for (const [k, v] of r) delta = delta.add(k, ElementSet(v));
        this._state = this._state.union(r);
        this._maxIndex = newMax;
      } else if (this._maxIndex.compareTo(newMax) > 0) {
        // window shrank on the upper side: drop entries `(newMax, maxIndex]`.
        const split = this._state.split(newMax);
        this._state = split.hasValue
          ? split.left.add(newMax, split.self as T)
          : split.left;
        for (const [k] of split.right) delta = delta.add(k, ElementRemove);
        this._maxIndex = newMax;
      }

      return IndexListDelta.ofMap(delta);
    }

    // New window is empty.
    if (this._state.isEmpty) return IndexListDelta.empty<T>();
    let delta = MapExt.empty<Index, ElementOperation<T>>(_indexCmp);
    for (const [k] of this._state) delta = delta.add(k, ElementRemove);
    this._state = MapExt.empty<Index, T>(_indexCmp);
    this._minIndex = indexZero;
    this._maxIndex = indexZero;
    return IndexListDelta.ofMap(delta);
  }
}

/** Apply a single delta op to a value cell (used by `SubReader`). */
function applyForElementOp<T>(
  _k: Index,
  existing: T | undefined,
  op: ElementOperation<T>,
): [T | undefined, ElementOperation<T> | undefined] {
  if (op.tag === "Remove") {
    if (existing !== undefined) return [undefined, ElementRemove];
    return [undefined, undefined];
  }
  if (existing !== undefined) {
    if (Object.is(existing, op.value)) return [op.value, undefined];
    return [op.value, ElementSet(op.value)];
  }
  return [op.value, ElementSet(op.value)];
}

const _indexCmp = (a: Index, b: Index): number => a.compareTo(b);

/** Reader for `pairwise` / `pairwiseCyclic`. */
class PairwiseReader<A> extends AbstractStatefulReader<
  IndexList<[A, A]>,
  IndexListDelta<[A, A]>
> {
  private readonly _reader: IIndexListReader<A>;
  private readonly _cyclic: boolean;
  constructor(input: alist<A>, cyclic: boolean) {
    super(indexListTrace<[A, A]>());
    this._reader = input.getReader();
    this._cyclic = cyclic;
  }

  private neighbours(
    s: IndexList<A>,
    i: Index,
  ): {
    left: [Index, A] | undefined;
    right: [Index, A] | undefined;
  } {
    const list = s.toListIndexed();
    const pos = list.findIndex(([k]) => k.equals(i));
    let left: [Index, A] | undefined;
    let right: [Index, A] | undefined;
    if (pos > 0) left = list[pos - 1];
    if (pos >= 0 && pos + 1 < list.length) right = list[pos + 1];
    if (right === undefined && this._cyclic && list.length > 0) {
      right = list[0];
    }
    if (left === undefined && this._cyclic && list.length > 0) {
      left = list[list.length - 1];
    }
    return { left, right };
  }

  override compute(tok: AdaptiveToken): IndexListDelta<[A, A]> {
    const oldState = this._reader.state;
    const ops = this._reader.getChanges(tok);
    const newState = this._reader.state;
    let out = IndexListDelta.empty<[A, A]>();
    for (const [i, op] of ops) {
      if (op.tag === "Remove") {
        if (oldState.tryGetByIndex(i) !== undefined) {
          const { left, right } = this.neighbours(newState, i);
          out = out.add(i, ElementRemove);
          if (left !== undefined) {
            if (right !== undefined)
              out = out.add(left[0], ElementSet([left[1], right[1]] as [A, A]));
            else out = out.add(left[0], ElementRemove);
          }
        }
      } else {
        const ov = oldState.tryGetByIndex(i);
        const { left, right } = this.neighbours(newState, i);
        if (ov !== undefined && Object.is(ov, op.value)) {
          // unchanged
        } else {
          if (right !== undefined)
            out = out.add(i, ElementSet([op.value, right[1]] as [A, A]));
          if (left !== undefined)
            out = out.add(left[0], ElementSet([left[1], op.value] as [A, A]));
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Reductions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ReduceValueAList — incremental reduction over alist values.
// Mirrors F#'s AdaptiveIndexList.Reductions.ReduceValue.
// ---------------------------------------------------------------------------

class ReduceValueAList<T, S, V> extends AbstractVal<V> {
  private readonly _reduction: AdaptiveReduction<T, S, V>;
  private readonly _reader: IIndexListReader<T>;
  private _state: IndexList<T> = IndexList.empty<T>();
  private _sum: S;

  constructor(reduction: AdaptiveReduction<T, S, V>, list: alist<T>) {
    super();
    this._reduction = reduction;
    this._reader = list.getReader();
    this._sum = reduction.seed;
  }

  override compute(tok: AdaptiveToken): V {
    const ops = this._reader.getChanges(tok);
    const stateCount = this._reader.state.count;

    if (stateCount <= 2 || stateCount <= ops.count) {
      this._state = this._reader.state;
      let s = this._reduction.seed;
      for (const v of this._state) s = this._reduction.add(s, v);
      this._sum = s;
      return this._reduction.view(s);
    }

    let working = true;
    for (const [index, op] of ops) {
      if (!working) break;
      if (op.tag === "Set") {
        const old = this._state.tryGetByIndex(index);
        if (old !== undefined) {
          const r = this._reduction.sub(this._sum, old);
          if (r === undefined) {
            working = false;
          } else {
            this._sum = r;
          }
        }
        this._sum = this._reduction.add(this._sum, op.value);
        this._state = this._state.setByIndex(index, op.value);
      } else {
        const old = this._state.tryGetByIndex(index);
        if (old !== undefined) {
          this._state = this._state.removeByIndex(index);
          const r = this._reduction.sub(this._sum, old);
          if (r === undefined) {
            working = false;
          } else {
            this._sum = r;
          }
        }
      }
    }

    if (!working) {
      this._state = this._reader.state;
      let s = this._reduction.seed;
      for (const v of this._state) s = this._reduction.add(s, v);
      this._sum = s;
    }
    return this._reduction.view(this._sum);
  }
}

// ---------------------------------------------------------------------------
// ReduceByValueAList — incremental reduction with sync (i,v)→b mapping.
// Mirrors F#'s AdaptiveIndexList.Reductions.ReduceByValue.
// ---------------------------------------------------------------------------

class ReduceByValueAList<A, B, S, V> extends AbstractVal<V> {
  private readonly _reduction: AdaptiveReduction<B, S, V>;
  private readonly _mapping: (i: Index, a: A) => B;
  private readonly _reader: IIndexListReader<A>;
  // Per-index entry: (input value, mapped value).
  private _state: IndexList<[A, B]> = IndexList.empty<[A, B]>();
  private _sum: S | undefined;

  constructor(
    reduction: AdaptiveReduction<B, S, V>,
    mapping: (i: Index, a: A) => B,
    list: alist<A>,
  ) {
    super();
    this._reduction = reduction;
    this._mapping = mapping;
    this._reader = list.getReader();
    this._sum = reduction.seed;
  }

  private add(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.add(s, v);
  }
  private sub(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.sub(s, v);
  }

  override compute(tok: AdaptiveToken): V {
    const ops = this._reader.getChanges(tok);
    const stateCount = this._reader.state.count;

    if (stateCount <= 2 || stateCount <= ops.count) {
      // Bulk recompute, reusing cached mappings for unchanged input
      // values (F# `tryGetV` + DefaultEquality.equals).
      let newState = IndexList.empty<[A, B]>();
      for (const [k, a] of this._reader.state.toListIndexed()) {
        const cur = this._state.tryGetByIndex(k);
        if (cur !== undefined && Object.is(cur[0], a)) {
          newState = newState.setByIndex(k, cur);
        } else {
          const b = this._mapping(k, a);
          newState = newState.setByIndex(k, [a, b]);
        }
      }
      this._state = newState;
      let s = this._reduction.seed;
      for (const [, b] of newState) s = this._reduction.add(s, b);
      this._sum = s;
      return this._reduction.view(s);
    }

    for (const [index, op] of ops) {
      if (op.tag === "Set") {
        const cur = this._state.tryGetByIndex(index);
        if (cur !== undefined && Object.is(cur[0], op.value)) continue;
        if (cur !== undefined) this._sum = this.sub(this._sum, cur[1]);
        const b = this._mapping(index, op.value);
        this._sum = this.add(this._sum, b);
        this._state = this._state.setByIndex(index, [op.value, b]);
      } else {
        const cur = this._state.tryGetByIndex(index);
        if (cur !== undefined) {
          this._state = this._state.removeByIndex(index);
          this._sum = this.sub(this._sum, cur[1]);
        }
      }
    }

    if (this._sum === undefined) {
      let s = this._reduction.seed;
      for (const [, b] of this._state) s = this._reduction.add(s, b);
      this._sum = s;
    }
    return this._reduction.view(this._sum);
  }
}

class AdaptiveReduceByValueAList<A, B, S, V> extends AbstractVal<V> {
  private readonly _reduction: AdaptiveReduction<B, S, V>;
  private readonly _mapping: (i: Index, a: A) => aval<B>;
  private readonly _reader: IIndexListReader<A>;
  private _state: HashTable<Index, [A, aval<B>, B]> = new HashTable();
  private _targets: MultiSetMap<aval<B>, Index> = MultiSetMap.empty<
    aval<B>,
    Index
  >();
  private _dirty: HashTable<Index, aval<B>> = new HashTable();
  private _sum: S | undefined;

  constructor(
    reduction: AdaptiveReduction<B, S, V>,
    mapping: (i: Index, a: A) => aval<B>,
    list: alist<A>,
  ) {
    super();
    this._reduction = reduction;
    this._mapping = mapping;
    this._reader = list.getReader();
    (this._reader as unknown as IAdaptiveObject).tag = "FoldReader";
    this._sum = reduction.seed;
  }

  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    if (o.tag === "FoldReader") return;
    const indices = MultiSetMap.find(
      o as unknown as aval<B>,
      this._targets,
    );
    for (const i of indices) this._dirty.set(i, o as unknown as aval<B>);
  }

  private add(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.add(s, v);
  }
  private sub(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.sub(s, v);
  }

  private removeIndex(i: Index): void {
    const cur = this._state.get(i);
    if (cur === undefined) return;
    const [, ov, o] = cur;
    this._state.delete(i);
    this._sum = this.sub(this._sum, o);
    const r = MultiSetMap.remove(ov, i, this._targets);
    this._targets = r.result;
    if (r.wasLast) (ov as unknown as IAdaptiveObject).outputs.remove(this);
  }

  override compute(tok: AdaptiveToken): V {
    const ops = this._reader.getChanges(tok);
    if (this._state.size <= 2 || this._state.size <= ops.count) {
      this._dirty.clear();
      for (const [m] of this._targets) {
        (m as unknown as IAdaptiveObject).outputs.remove(this);
      }
      this._targets = MultiSetMap.empty<aval<B>, Index>();
      const newState = new HashTable<Index, [A, aval<B>, B]>();
      for (const [k, a] of this._reader.state.toListIndexed()) {
        const old = this._state.get(k);
        if (old !== undefined && Object.is(old[0], a)) {
          const [oa, m] = old;
          const v = m.getValue(tok);
          this._targets = MultiSetMap.add(m, k, this._targets);
          newState.set(k, [oa, m, v]);
        } else {
          const m = this._mapping(k, a);
          const v = m.getValue(tok);
          this._targets = MultiSetMap.add(m, k, this._targets);
          newState.set(k, [a, m, v]);
        }
      }
      this._state = newState;
      let s = this._reduction.seed;
      for (const [, [, , v]] of newState) s = this._reduction.add(s, v);
      this._sum = s;
      return this._reduction.view(s);
    }

    const dirty = new HashTable<Index, aval<B>>();
    for (const [k, v] of this._dirty) dirty.set(k, v);
    this._dirty.clear();
    for (const [i, op] of ops) {
      dirty.delete(i);
      if (op.tag === "Set") {
        const old = this._state.get(i);
        if (old !== undefined && Object.is(old[0], op.value)) continue;
        this.removeIndex(i);
        const r = this._mapping(i, op.value);
        const n = r.getValue(tok);
        this._targets = MultiSetMap.add(r, i, this._targets);
        this._state.set(i, [op.value, r, n]);
        this._sum = this.add(this._sum, n);
      } else {
        this.removeIndex(i);
      }
    }
    for (const [i, r] of dirty) {
      const n = r.getValue(tok);
      const cur = this._state.get(i);
      if (cur !== undefined) {
        const [a, ro, o] = cur;
        this._sum = this.add(this.sub(this._sum, o), n);
        this._state.set(i, [a, ro, n]);
      }
    }
    if (this._sum === undefined) {
      let s = this._reduction.seed;
      for (const [, [, , v]] of this._state) s = this._reduction.add(s, v);
      this._sum = s;
    }
    return this._reduction.view(this._sum);
  }
}

// ---------------------------------------------------------------------------
// Module-level functions
// ---------------------------------------------------------------------------

export function empty<T>(): alist<T> {
  return EmptyList.instance<T>();
}
export function single<T>(value: T): alist<T> {
  return constant(() => IndexList.single(value));
}
export function ofSeq<T>(values: Iterable<T>): alist<T> {
  return constant(() => IndexList.ofSeq(values));
}
export function ofList<T>(values: T[]): alist<T> {
  return constant(() => IndexList.ofList(values));
}
export function ofArray<T>(values: T[]): alist<T> {
  return constant(() => IndexList.ofArray(values));
}
export function ofIndexList<T>(values: IndexList<T>): alist<T> {
  return constant(() => values);
}
export { constant };

export function ofReader<T>(
  creator: () => IOpReader<IndexListDelta<T>>,
): alist<T> {
  return ofReaderInternal<T>(creator);
}

export function custom<T>(
  compute: (tok: AdaptiveToken, state: IndexList<T>) => IndexListDelta<T>,
): alist<T> {
  return ofReaderInternal<T>(() => {
    const trace = indexListTrace<T>();
    class Custom extends AbstractStatefulReader<
      IndexList<T>,
      IndexListDelta<T>
    > {
      constructor() {
        super(trace);
      }
      override compute(tok: AdaptiveToken): IndexListDelta<T> {
        return compute(tok, this._state);
      }
      override applyOp(op: IndexListDelta<T>): IndexListDelta<T> {
        const r = IndexListDeltaExt.applyDelta(this._state, op);
        this._state = r.state;
        return r.delta;
      }
    }
    return new Custom();
  });
}

export function toAVal<T>(list: alist<T>): aval<IndexList<T>> {
  return list.content;
}

/**
 * Generates an alist of length `length.value`, where each element is
 * computed via `initializer(i)`.
 *
 * PORT NOTE: F#'s `AList.init` is generic over the length type; the
 * port specialises to `number` (matches the JS idiom).
 */
export function init<T>(
  length: aval<number>,
  initializer: (i: number) => T,
): alist<T> {
  if (length.isConstant) {
    return constant(() => {
      const n = Math.max(0, AVal.force(length) | 0);
      let l = IndexList.empty<T>();
      for (let i = 0; i < n; i++) l = l.add(initializer(i));
      return l;
    });
  }
  return ofReaderInternal<T>(() => new InitReader<T>(length, initializer));
}

/**
 * Generates an alist over the integer range `[lower, upper]`.
 *
 * PORT NOTE: specialised for `number` (F# uses generic numeric
 * arithmetic via SRTP). For empty ranges (`upper < lower`) the
 * resulting alist is empty.
 */
export function range(
  lower: aval<number>,
  upper: aval<number>,
): alist<number> {
  if (lower.isConstant && upper.isConstant) {
    return constant(() => {
      const lo = AVal.force(lower) | 0;
      const hi = AVal.force(upper) | 0;
      let l = IndexList.empty<number>();
      for (let i = lo; i <= hi; i++) l = l.add(i);
      return l;
    });
  }
  return ofReaderInternal<number>(() => new RangeReader(lower, upper));
}

export function ofAVal<T>(value: aval<Iterable<T>>): alist<T> {
  if (value.isConstant) {
    return constant(() => IndexList.ofSeq(AVal.force(value)));
  }
  return ofReaderInternal<T>(() => new AValReader<T>(value));
}

export function mapi<A, B>(
  mapping: (i: Index, a: A) => B,
  list: alist<A>,
): alist<B> {
  if (list.isConstant) return constant(() => force(list).map(mapping));
  if (list.history !== undefined) {
    const hist = list.history;
    return ofReaderInternal<B>(
      () =>
        hist.newViewReader<IndexList<B>, IndexListDelta<B>>(
          indexListTrace<B>(),
          MapReader.deltaMapping<A, B>(mapping),
        ) as IOpReader<IndexListDelta<B>>,
    );
  }
  return ofReaderInternal<B>(() => new MapReader<A, B>(list, mapping));
}

export function map<A, B>(mapping: (a: A) => B, list: alist<A>): alist<B> {
  return mapi<A, B>((_i, v) => mapping(v), list);
}

export function choosei<A, B>(
  mapping: (i: Index, a: A) => B | undefined,
  list: alist<A>,
): alist<B> {
  if (list.isConstant) return constant(() => force(list).choose(mapping));
  return ofReaderInternal<B>(() => new ChooseReader<A, B>(list, mapping));
}
export function choose<A, B>(
  mapping: (a: A) => B | undefined,
  list: alist<A>,
): alist<B> {
  return choosei<A, B>((_i, v) => mapping(v), list);
}

export function filteri<A>(
  predicate: (i: Index, a: A) => boolean,
  list: alist<A>,
): alist<A> {
  if (list.isConstant) return constant(() => force(list).filter(predicate));
  return ofReaderInternal<A>(() => new FilterReader<A>(list, predicate));
}
export function filter<A>(
  predicate: (a: A) => boolean,
  list: alist<A>,
): alist<A> {
  return filteri<A>((_i, v) => predicate(v), list);
}

export function mapAi<A, B>(
  mapping: (i: Index, a: A) => aval<B>,
  list: alist<A>,
): alist<B> {
  return ofReaderInternal<B>(() => new MapAReader<A, B>(list, mapping));
}
export function mapA<A, B>(
  mapping: (a: A) => aval<B>,
  list: alist<A>,
): alist<B> {
  return mapAi<A, B>((_i, v) => mapping(v), list);
}

export function chooseAi<A, B>(
  mapping: (i: Index, a: A) => aval<B | undefined>,
  list: alist<A>,
): alist<B> {
  return ofReaderInternal<B>(() => new ChooseAReader<A, B>(list, mapping));
}
export function chooseA<A, B>(
  mapping: (a: A) => aval<B | undefined>,
  list: alist<A>,
): alist<B> {
  return chooseAi<A, B>((_i, v) => mapping(v), list);
}

export function filterAi<A>(
  predicate: (i: Index, a: A) => aval<boolean>,
  list: alist<A>,
): alist<A> {
  return chooseAi<A, A>(
    (i, v) => AVal.map(predicate(i, v), (b) => (b ? v : undefined)),
    list,
  );
}
export function filterA<A>(
  predicate: (a: A) => aval<boolean>,
  list: alist<A>,
): alist<A> {
  return filterAi<A>((_i, v) => predicate(v), list);
}

export function collecti<A, B>(
  mapping: (i: Index, a: A) => alist<B>,
  list: alist<A>,
): alist<B> {
  if (list.isConstant) {
    const content = force(list).map(mapping);
    if (content.forall((_i, l) => l.isConstant)) {
      return constant(() => content.collect((l) => force(l)));
    }
    return ofReaderInternal<B>(() => new ConcatReader<B>(content));
  }
  return ofReaderInternal<B>(() => new CollectReader<A, B>(list, mapping));
}
export function collect<A, B>(
  mapping: (a: A) => alist<B>,
  list: alist<A>,
): alist<B> {
  return collecti<A, B>((_i, v) => mapping(v), list);
}
export function collectSeq<A, B>(
  mapping: (a: A) => Iterable<B>,
  list: alist<A>,
): alist<B> {
  return collecti<A, B>((_i, v) => ofSeq(mapping(v)), list);
}

export function indexed<T>(list: alist<T>): alist<[Index, T]> {
  return mapi<T, [Index, T]>((i, v) => [i, v] as [Index, T], list);
}

export function concat<T>(lists: Iterable<alist<T>>): alist<T> {
  const arr = IndexList.ofArray([...lists]);
  if (arr.isEmpty) return empty<T>();
  if (arr.forall((_i, l) => l.isConstant)) {
    return constant(() => arr.collect((l) => force(l)));
  }
  return ofReaderInternal<T>(() => new ConcatReader<T>(arr));
}

export function append<T>(l: alist<T>, r: alist<T>): alist<T> {
  if (l.isConstant && r.isConstant) {
    return constant(() => IndexList.append(force(l), force(r)));
  }
  return ofReaderInternal<T>(
    () => new ConcatReader<T>(IndexList.ofArray([l, r])),
  );
}

export function bind<A, B>(
  mapping: (a: A) => alist<B>,
  value: aval<A>,
): alist<B> {
  if (value.isConstant) return mapping(AVal.force(value));
  return ofReaderInternal<B>(() => new BindReader<A, B>(value, mapping));
}

type AValValuesList<T extends ReadonlyArray<aval<unknown>>> = {
  [K in keyof T]: T[K] extends aval<infer U> ? U : never;
};

export class ListZipped<Ts extends readonly unknown[]> {
  private readonly _avals: ReadonlyArray<aval<unknown>>;
  constructor(avals: ReadonlyArray<aval<unknown>>) { this._avals = avals; }
  bind<R>(f: (...vs: Ts) => alist<R>): alist<R> {
    const avals = this._avals;
    const tuple: aval<Ts> = AVal.custom((tok) => {
      return avals.map((v) => (v as unknown as { getValue(t: AdaptiveToken): unknown }).getValue(tok)) as unknown as Ts;
    });
    return bind((t) => f(...t), tuple);
  }
}

export function zip<T extends readonly aval<unknown>[]>(...vals: T): ListZipped<AValValuesList<T>> {
  return new ListZipped<AValValuesList<T>>(vals);
}

export function sortByi<A, B>(
  mapping: (i: Index, a: A) => B,
  list: alist<A>,
  compare?: (a: B, b: B) => number,
): alist<A> {
  if (list.isConstant) {
    return constant(() => {
      const arr = [...force(list).toListIndexed()];
      arr.sort(([li, la], [ri, ra]) => {
        const lk = mapping(li, la);
        const rk = mapping(ri, ra);
        const cmp = compare ?? ((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const c = cmp(lk, rk);
        return c !== 0 ? c : li.compareTo(ri);
      });
      return IndexList.ofArray(arr.map(([, v]) => v));
    });
  }
  return ofReaderInternal<A>(
    () => new SortByReader<A, B>(list, mapping, compare),
  );
}
export function sortBy<A, B>(
  mapping: (a: A) => B,
  list: alist<A>,
  compare?: (a: B, b: B) => number,
): alist<A> {
  return sortByi<A, B>((_i, v) => mapping(v), list, compare);
}

export function sortWith<T>(
  compare: (a: T, b: T) => number,
  list: alist<T>,
): alist<T> {
  if (list.isConstant) {
    return constant(() => force(list).sortWith(compare));
  }
  return ofReaderInternal<T>(() => new SortWithReader<T>(list, compare));
}

export function sort<T>(list: alist<T>): alist<T> {
  return sortWith<T>((a, b) => (a < b ? -1 : a > b ? 1 : 0), list);
}
export function sortDescending<T>(list: alist<T>): alist<T> {
  return sortWith<T>((a, b) => (b < a ? -1 : b > a ? 1 : 0), list);
}
export function rev<T>(list: alist<T>): alist<T> {
  return sortByi<T, Index>((i) => i, list, (a, b) => b.compareTo(a));
}

/**
 * Adaptively skips `offset` elements and takes `count`.
 * Indices in the resulting alist are inherited from the source.
 */
export function subA<T>(
  offset: aval<number>,
  count: aval<number>,
  list: alist<T>,
): alist<T> {
  if (list.isConstant && offset.isConstant && count.isConstant) {
    const o = AVal.force(offset) | 0;
    const c = AVal.force(count) | 0;
    return constant(() => {
      const src = force(list);
      const total = src.count;
      const lo = Math.max(0, Math.min(o, total));
      const hi = Math.min(o + c - 1, total - 1);
      if (hi < lo) return IndexList.empty<T>();
      return IndexList.fromMap(src.content.sliceAt(lo, hi));
    });
  }
  return ofReaderInternal<T>(() => new SubReader<T>(list, offset, count));
}

/** Adaptively skips `offset` elements and takes `count`. */
export function sub<T>(offset: number, count: number, list: alist<T>): alist<T> {
  return subA<T>(AVal.constant(offset), AVal.constant(count), list);
}

/** Adaptively takes `count` elements from the front. */
export function take<T>(count: number, list: alist<T>): alist<T> {
  return sub<T>(0, count, list);
}
/** Adaptively takes `count` (aval) elements from the front. */
export function takeA<T>(count: aval<number>, list: alist<T>): alist<T> {
  return subA<T>(AVal.constant(0), count, list);
}
/** Adaptively skips the first `count` elements. */
export function skip<T>(count: number, list: alist<T>): alist<T> {
  return subA<T>(AVal.constant(count), AVal.constant(0x7fffffff), list);
}
/** Adaptively skips the first `count` (aval) elements. */
export function skipA<T>(count: aval<number>, list: alist<T>): alist<T> {
  return subA<T>(count, AVal.constant(0x7fffffff), list);
}

export function pairwise<T>(list: alist<T>): alist<[T, T]> {
  if (list.isConstant) {
    return constant(() => {
      const out: Array<[T, T]> = [];
      const arr = [...force(list)];
      for (let i = 0; i + 1 < arr.length; i++)
        out.push([arr[i]!, arr[i + 1]!]);
      return IndexList.ofArray(out);
    });
  }
  return ofReaderInternal<[T, T]>(() => new PairwiseReader<T>(list, false));
}

export function pairwiseCyclic<T>(list: alist<T>): alist<[T, T]> {
  if (list.isConstant) {
    return constant(() => {
      const out: Array<[T, T]> = [];
      const arr = [...force(list)];
      for (let i = 0; i < arr.length; i++)
        out.push([arr[i]!, arr[(i + 1) % arr.length]!]);
      return IndexList.ofArray(out);
    });
  }
  return ofReaderInternal<[T, T]>(() => new PairwiseReader<T>(list, true));
}

export function tryGet<T>(index: Index, list: alist<T>): aval<T | undefined> {
  return AVal.map(list.content, (s) => s.tryGetByIndex(index));
}
export function tryAt<T>(pos: number, list: alist<T>): aval<T | undefined> {
  return AVal.map(list.content, (s) => s.tryGetByPosition(pos));
}
export function tryFirst<T>(list: alist<T>): aval<T | undefined> {
  return AVal.map(list.content, (s) =>
    s.isEmpty ? undefined : s.tryGetByIndex(s.minIndex),
  );
}
export function tryLast<T>(list: alist<T>): aval<T | undefined> {
  return AVal.map(list.content, (s) =>
    s.isEmpty ? undefined : s.tryGetByIndex(s.maxIndex),
  );
}

export function isEmpty<T>(list: alist<T>): aval<boolean> {
  return AVal.map(list.content, (s) => s.isEmpty);
}
export function count<T>(list: alist<T>): aval<number> {
  return AVal.map(list.content, (s) => s.count);
}

// Reductions ----------------------------------------------------------------

/**
 * Adaptively reduces the list using the given `AdaptiveReduction`.
 * Incremental: applies `add`/`sub` per delta op, only bulk-recomputes
 * when the delta is bigger than the state or `sub` fails.
 * Mirrors F#'s `AdaptiveIndexList.Reductions.ReduceValue`.
 */
export function reduce<T, S, V>(
  reduction: AdaptiveReduction<T, S, V>,
  list: alist<T>,
): aval<V> {
  return new ReduceValueAList<T, S, V>(reduction, list);
}

/**
 * Adaptively reduces the list after mapping each entry through a
 * synchronous `mapping`. Maintains a per-index cache of (input value,
 * mapped value) and adds/subtracts incrementally per delta op,
 * only re-running `mapping` when the input value changes.
 * Mirrors F#'s `AdaptiveIndexList.Reductions.ReduceByValue`.
 */
export function reduceBy<A, B, S, V>(
  reduction: AdaptiveReduction<B, S, V>,
  mapping: (i: Index, a: A) => B,
  list: alist<A>,
): aval<V> {
  return new ReduceByValueAList<A, B, S, V>(reduction, mapping, list);
}

export function reduceByA<A, B, S, V>(
  reduction: AdaptiveReduction<B, S, V>,
  mapping: (i: Index, a: A) => aval<B>,
  list: alist<A>,
): aval<V> {
  return new AdaptiveReduceByValueAList<A, B, S, V>(reduction, mapping, list);
}

export function fold<T, S>(
  add: (s: S, t: T) => S,
  zero: S,
  list: alist<T>,
): aval<S> {
  return reduce(Reductions.fold(zero, add), list);
}
export function foldGroup<T, S>(
  add: (s: S, t: T) => S,
  sub: (s: S, t: T) => S,
  zero: S,
  list: alist<T>,
): aval<S> {
  return reduce(Reductions.group(zero, add, sub), list);
}
export function foldHalfGroup<T, S>(
  add: (s: S, t: T) => S,
  trySub: (s: S, t: T) => S | undefined,
  zero: S,
  list: alist<T>,
): aval<S> {
  return reduce(Reductions.halfGroup(zero, add, trySub), list);
}

export function forall<T>(
  predicate: (t: T) => boolean,
  list: alist<T>,
): aval<boolean> {
  return reduceBy<T, boolean, number, boolean>(
    Reductions.mapOut((n) => n === 0, Reductions.countNegative),
    (_i, v) => predicate(v),
    list,
  );
}
export function exists<T>(
  predicate: (t: T) => boolean,
  list: alist<T>,
): aval<boolean> {
  return reduceBy<T, boolean, number, boolean>(
    Reductions.mapOut((n) => n !== 0, Reductions.countPositive),
    (_i, v) => predicate(v),
    list,
  );
}
export function forallA<T>(
  predicate: (t: T) => aval<boolean>,
  list: alist<T>,
): aval<boolean> {
  return reduceByA<T, boolean, number, boolean>(
    Reductions.mapOut((n) => n === 0, Reductions.countNegative),
    (_i, v) => predicate(v),
    list,
  );
}
export function existsA<T>(
  predicate: (t: T) => aval<boolean>,
  list: alist<T>,
): aval<boolean> {
  return reduceByA<T, boolean, number, boolean>(
    Reductions.mapOut((n) => n !== 0, Reductions.countPositive),
    (_i, v) => predicate(v),
    list,
  );
}

export function countBy<T>(
  predicate: (t: T) => boolean,
  list: alist<T>,
): aval<number> {
  return reduceBy(Reductions.countPositive, (_i, v) => predicate(v), list);
}
export function countByA<T>(
  predicate: (t: T) => aval<boolean>,
  list: alist<T>,
): aval<number> {
  return reduceByA(Reductions.countPositive, (_i, v) => predicate(v), list);
}

export function sum(list: alist<number>): aval<number> {
  return reduce(Reductions.sum, list);
}
export function sumBy<T>(
  mapping: (t: T) => number,
  list: alist<T>,
): aval<number> {
  return reduceBy(Reductions.sum, (_i, v) => mapping(v), list);
}
export function sumByA<T>(
  mapping: (t: T) => aval<number>,
  list: alist<T>,
): aval<number> {
  return reduceByA(Reductions.sum, (_i, v) => mapping(v), list);
}
export function average(list: alist<number>): aval<number> {
  return reduce(Reductions.average, list);
}
export function averageBy<T>(
  mapping: (t: T) => number,
  list: alist<T>,
): aval<number> {
  return reduceBy(Reductions.average, (_i, v) => mapping(v), list);
}
export function averageByA<T>(
  mapping: (t: T) => aval<number>,
  list: alist<T>,
): aval<number> {
  return reduceByA(Reductions.average, (_i, v) => mapping(v), list);
}

/**
 * Adaptively the smallest element (or `undefined`). Incremental via
 * `reduce` with `AdaptiveReduction.tryMin`. Mirrors F#'s `tryMin`.
 */
export function tryMin<T>(
  list: alist<T>,
  compare?: (a: T, b: T) => number,
): aval<T | undefined> {
  const cmp = compare ?? ((a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0));
  return reduce<T, T | undefined, T | undefined>(
    Reductions.tryMin(cmp),
    list,
  );
}

/**
 * Adaptively the largest element (or `undefined`). Incremental via
 * `reduce` with `AdaptiveReduction.tryMax`. Mirrors F#'s `tryMax`.
 */
export function tryMax<T>(
  list: alist<T>,
  compare?: (a: T, b: T) => number,
): aval<T | undefined> {
  const cmp = compare ?? ((a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0));
  return reduce<T, T | undefined, T | undefined>(
    Reductions.tryMax(cmp),
    list,
  );
}

// ---------------------------------------------------------------------------
// AList namespace export
// ---------------------------------------------------------------------------

export const AList = {
  empty,
  single,
  ofSeq,
  ofList,
  ofArray,
  ofIndexList,
  init,
  range,
  subA,
  sub,
  take,
  takeA,
  skip,
  skipA,
  constant,
  ofReader,
  custom,
  ofAVal,
  toAVal,
  mapi,
  map,
  choosei,
  choose,
  filteri,
  filter,
  mapAi,
  mapA,
  chooseAi,
  chooseA,
  filterAi,
  filterA,
  collecti,
  collect,
  collectSeq,
  indexed,
  concat,
  append,
  bind,
  zip,
  sortByi,
  sortBy,
  sortWith,
  sort,
  sortDescending,
  rev,
  pairwise,
  pairwiseCyclic,
  tryGet,
  tryAt,
  tryFirst,
  tryLast,
  isEmpty,
  count,
  force,
  reduce,
  reduceBy,
  reduceByA,
  fold,
  foldGroup,
  foldHalfGroup,
  forall,
  exists,
  forallA,
  existsA,
  countBy,
  countByA,
  sum,
  sumBy,
  sumByA,
  average,
  averageBy,
  averageByA,
  tryMin,
  tryMax,
};

