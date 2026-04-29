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
import { Index } from "../datastructures/index.js";
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
}

export function force<T>(list: alist<T>): IndexList<T> {
  return AVal.force(list.content);
}

// ---------------------------------------------------------------------------
// Empty / Constant / Impl
// ---------------------------------------------------------------------------

class EmptyList<T> implements alist<T> {
  readonly isConstant = true;
  readonly content: aval<IndexList<T>> = avalConstant(IndexList.empty<T>());
  readonly history = undefined;
  private static _cached: EmptyList<unknown> | null = null;
  static instance<T>(): alist<T> {
    if (!EmptyList._cached) EmptyList._cached = new EmptyList<unknown>();
    return EmptyList._cached as unknown as alist<T>;
  }
  getReader(): IIndexListReader<T> {
    return new EmptyReader<IndexList<T>, IndexListDelta<T>>(indexListTrace<T>());
  }
}

class ConstantList<T> implements alist<T> {
  readonly isConstant = true;
  private readonly _create: () => IndexList<T>;
  private _cached: IndexList<T> | null = null;
  readonly content: aval<IndexList<T>>;
  readonly history = undefined;
  constructor(create: () => IndexList<T>) {
    this._create = create;
    this.content = avalDelay(() => this.lazy());
  }
  private lazy(): IndexList<T> {
    if (this._cached === null) this._cached = this._create();
    return this._cached;
  }
  getReader(): IIndexListReader<T> {
    return new ConstantReader<IndexList<T>, IndexListDelta<T>>(
      indexListTrace<T>(),
      () =>
        IndexListDeltaExt.computeDelta<T>(IndexList.empty<T>(), this.lazy()),
      () => this.lazy(),
    );
  }
}

class AdaptiveIndexListImpl<T> implements alist<T> {
  readonly isConstant = false;
  readonly history: History<IndexList<T>, IndexListDelta<T>>;
  readonly content: aval<IndexList<T>>;
  constructor(createReader: () => IOpReader<IndexListDelta<T>>) {
    this.history = History.ofReader<IndexList<T>, IndexListDelta<T>>(
      indexListTrace<T>(),
      createReader,
    );
    this.content = AVal.custom((tok) => {
      this.history.getValue(tok);
      return this.history.state;
    });
  }
  getReader(): IIndexListReader<T> {
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
 * Reader for `range` over `number`. On each compute, rebuilds the
 * full new range and diffs against the previous state via
 * `IndexListDeltaExt.computeDelta`. Reuses indices for unchanged
 * positions where possible.
 *
 * PORT NOTE: F# AList.range optimises this with an explicit
 * four-region delta (lower/upper × +/-) computed by
 * `RangeDelta.rangeChange`. The simpler diff-the-state approach
 * here gives identical observable behaviour at slightly higher
 * cost when bounds change incrementally.
 */
class RangeReader extends AbstractStatefulReader<
  IndexList<number>,
  IndexListDelta<number>
> {
  private readonly _lower: aval<number>;
  private readonly _upper: aval<number>;
  constructor(lower: aval<number>, upper: aval<number>) {
    super(indexListTrace<number>());
    this._lower = lower;
    this._upper = upper;
  }
  override compute(tok: AdaptiveToken): IndexListDelta<number> {
    const newMin = this._lower.getValue(tok) | 0;
    const newMax = this._upper.getValue(tok) | 0;
    let next = IndexList.empty<number>();
    for (let v = newMin; v <= newMax; v++) next = next.add(v);
    return IndexListDeltaExt.computeDelta(this._state, next);
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
    super({ mempty: IndexListDelta.empty<B>() }, (tag) => tag !== "input");
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
    super({ mempty: IndexListDelta.empty<B>() }, (tag) => tag !== "input");
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
      (tag) => tag === "InnerReader",
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
      (tag) => tag === "MultiReader",
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
 * Reader for `subA` / `sub` / `take*` / `skip*`. Pulls the upstream
 * fully on each compute, slices by ordinal `[offset, offset+count-1]`,
 * and diffs against our previous slice via `computeDelta`. Output
 * preserves upstream indices.
 *
 * PORT NOTE: F#'s `SubReader` is a hand-tuned four-region merge
 * against `MapExt` slice/split primitives. Our equivalent rebuilds
 * the slice and diffs — same observable behaviour at slightly
 * higher per-tick cost. Worth revisiting if profiles show this in
 * a hot path.
 */
class SubReader<T> extends AbstractStatefulReader<
  IndexList<T>,
  IndexListDelta<T>
> {
  private readonly _reader: IIndexListReader<T>;
  private readonly _offset: aval<number>;
  private readonly _count: aval<number>;
  constructor(input: alist<T>, offset: aval<number>, count: aval<number>) {
    super(indexListTrace<T>());
    this._reader = input.getReader();
    this._offset = offset;
    this._count = count;
  }
  override compute(tok: AdaptiveToken): IndexListDelta<T> {
    // Pull upstream so reader.state is current.
    this._reader.getChanges(tok);
    const offset = Math.max(0, this._offset.getValue(tok) | 0);
    const count = Math.max(0, this._count.getValue(tok) | 0);
    const up = this._reader.state;
    const total = up.count;
    const lo = Math.min(offset, total);
    const hi = Math.min(offset + count - 1, total - 1);
    const next =
      hi < lo
        ? IndexList.empty<T>()
        : IndexList.fromMap(up.content.sliceAt(lo, hi));
    return IndexListDeltaExt.computeDelta(this._state, next);
  }
}

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

export function bind2<A, B, C>(
  mapping: (a: A, b: B) => alist<C>,
  va: aval<A>,
  vb: aval<B>,
): alist<C> {
  const zipped: aval<[A, B]> = AVal.zip(va, vb).map((a, b) => [a, b] as [A, B]);
  return bind<[A, B], C>(([a, b]) => mapping(a, b), zipped);
}

export function bind3<A, B, C, D>(
  mapping: (a: A, b: B, c: C) => alist<D>,
  va: aval<A>,
  vb: aval<B>,
  vc: aval<C>,
): alist<D> {
  const zipped: aval<[A, B, C]> = AVal.zip(va, vb, vc).map(
    (a, b, c) => [a, b, c] as [A, B, C],
  );
  return bind<[A, B, C], D>(([a, b, c]) => mapping(a, b, c), zipped);
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

export function reduce<T, S, V>(
  reduction: AdaptiveReduction<T, S, V>,
  list: alist<T>,
): aval<V> {
  return AVal.map(list.content, (s) => {
    let acc = reduction.seed;
    s.iter((_i, v) => (acc = reduction.add(acc, v)));
    return reduction.view(acc);
  });
}

export function reduceBy<A, B, S, V>(
  reduction: AdaptiveReduction<B, S, V>,
  mapping: (i: Index, a: A) => B,
  list: alist<A>,
): aval<V> {
  return AVal.map(list.content, (s) => {
    let acc = reduction.seed;
    s.iter((i, v) => (acc = reduction.add(acc, mapping(i, v))));
    return reduction.view(acc);
  });
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
  bind2,
  bind3,
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
};

