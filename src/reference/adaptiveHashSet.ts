// Port of FSharp.Data.Adaptive.Reference/AdaptiveHashSet.fs
//
// PORT NOTE: this is the slow-but-correct reference impl. Each
// `getReader().getChanges` call recomputes the full content and
// diffs it against the last observed state via `HashSet.computeDelta`.

import { HashSet, HashSetOps } from "../datastructures/hashCollections.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import { AVal, AdaptiveToken, type aval } from "./adaptiveValue.js";

/** The reference implementation for IOpReader<_>. */
export interface IOpReader<Delta> {
  getChanges(t: AdaptiveToken): Delta;
}

/** The reference implementation for IOpReader<_,_>. */
export interface IOpReaderWithState<State, Delta> extends IOpReader<Delta> {
  readonly state: State;
}

/** The reference implementation for IHashSetReader. */
export type IHashSetReader<T> = IOpReaderWithState<HashSet<T>, HashSetDelta<T>>;

/** The reference implementation for aset. */
export interface aset<T> {
  getReader(): IHashSetReader<T>;
  readonly content: aval<HashSet<T>>;
}

/** A simple reader using `HashSet.computeDelta` for getting deltas. */
class ASetReader<T> implements IHashSetReader<T> {
  private _last: HashSet<T> = HashSet.empty<T>();
  private readonly _set: aset<T>;
  constructor(set: aset<T>) {
    this._set = set;
  }
  get state(): HashSet<T> {
    return this._last;
  }
  getChanges(t: AdaptiveToken): HashSetDelta<T> {
    const c = this._set.content.getValue(t);
    const ops = HashSetDelta.ofHashMap(this._last.computeDeltaAsHashMapStd(c));
    this._last = c;
    return ops;
  }
}

/** A reference implementation for cset. */
export class ChangeableHashSet<T> implements aset<T> {
  private _content: HashSet<T>;
  readonly content: aval<HashSet<T>>;

  constructor(value?: HashSet<T> | Iterable<T>) {
    this._content =
      value === undefined
        ? HashSet.empty<T>()
        : value instanceof HashSet
          ? value
          : HashSet.ofSeq<T>(value);
    this.content = {
      getValue: () => this._content,
    };
  }

  /** Indicates if the set is empty. */
  get isEmpty(): boolean {
    return this._content.isEmpty;
  }

  /** Indicates the number of entries in the set. */
  get count(): number {
    return this._content.count;
  }

  /** Checks whether the given value is contained in the set. */
  contains(value: T): boolean {
    return this._content.contains(value);
  }

  /** Adds the given value to the set and returns true if the element was new. */
  add(value: T): boolean {
    const w = this._content.contains(value);
    this._content = this._content.add(value);
    return !w;
  }

  /** Removes the given element from the set and returns true if the element was deleted. */
  remove(value: T): boolean {
    const w = this._content.contains(value);
    this._content = this._content.remove(value);
    return w;
  }

  /** Removes all entries from the set. */
  clear(): void {
    this._content = HashSet.empty<T>();
  }

  /** Adds all given values to the set. */
  unionWith(other: Iterable<T>): void {
    this._content = this._content.unionWith(HashSet.ofSeq(other));
  }

  /** Removes all given values from the set. */
  exceptWith(other: Iterable<T>): void {
    this._content = this._content.exceptWith(HashSet.ofSeq(other));
  }

  /** Gets or sets the current immutable state of the set. */
  get value(): HashSet<T> {
    return this._content;
  }
  set value(v: HashSet<T>) {
    this._content = v;
  }

  getReader(): IHashSetReader<T> {
    return new ASetReader<T>(this);
  }
}

export type cset<T> = ChangeableHashSet<T>;

function ofRef<T>(r: aval<HashSet<T>>): aset<T> {
  const self: aset<T> = {
    content: r,
    getReader: () => new ASetReader<T>(self),
  };
  return self;
}

/** Functional operators for the aset reference-implementation. */
export const ASet = {
  /** The empty aset. */
  empty<T>(): aset<T> {
    return ofRef(AVal.constant(HashSet.empty<T>()));
  },
  /** A constant aset containing a single value. */
  single<T>(value: T): aset<T> {
    return ofRef(AVal.constant(HashSet.single(value)));
  },
  /** Creates a constant aset from the given values. */
  ofSeq<T>(values: Iterable<T>): aset<T> {
    return ofRef(AVal.constant(HashSet.ofSeq(values)));
  },
  /** Creates a constant aset from the given values. */
  ofList<T>(values: T[]): aset<T> {
    return ofRef(AVal.constant(HashSet.ofList(values)));
  },
  /** Creates a constant aset from the given values. */
  ofArray<T>(values: T[]): aset<T> {
    return ofRef(AVal.constant(HashSet.ofArray(values)));
  },
  /** Creates a constant aset from the given values. */
  ofHashSet<T>(values: HashSet<T>): aset<T> {
    return ofRef(AVal.constant(values));
  },
  /** Creates an adaptive value holding the set's content. */
  toAVal<T>(set: aset<T>): aval<HashSet<T>> {
    return set.content;
  },
  /** Applies mapping to all elements of the set and returns the resulting set. */
  map<T, B>(mapping: (t: T) => B, set: aset<T>): aset<B> {
    return ofRef(AVal.map((s) => s.map(mapping), set.content));
  },
  /** Applies mapping to all elements of the set and returns the resulting set. */
  choose<T, B>(mapping: (t: T) => B | undefined, set: aset<T>): aset<B> {
    return ofRef(AVal.map((s) => s.choose(mapping), set.content));
  },
  /** Filters the set using the given predicate. */
  filter<T>(predicate: (t: T) => boolean, set: aset<T>): aset<T> {
    return ofRef(AVal.map((s) => s.filter(predicate), set.content));
  },
  /** Unions the sets. */
  union<T>(a: aset<T>, b: aset<T>): aset<T> {
    return ofRef(AVal.map2((x, y) => x.unionWith(y), a.content, b.content));
  },
  /** Intersects the sets. */
  intersect<T>(a: aset<T>, b: aset<T>): aset<T> {
    return ofRef(AVal.map2((x, y) => x.intersectWith(y), a.content, b.content));
  },
  /** Subtracts the sets. */
  difference<T>(a: aset<T>, b: aset<T>): aset<T> {
    return ofRef(AVal.map2((x, y) => x.exceptWith(y), a.content, b.content));
  },
  /** "Xors" the sets. */
  xor<T>(a: aset<T>, b: aset<T>): aset<T> {
    return ofRef(
      AVal.map2((x, y) => x.symmetricExceptWith(y), a.content, b.content),
    );
  },
  /** Unions all the sets. */
  unionMany<T>(sets: aset<aset<T>>): aset<T> {
    return ofRef(
      AVal.map(
        (ss) =>
          HashSetOps.collect((s) => s.content.getValue(AdaptiveToken.top), ss),
        sets.content,
      ),
    );
  },
  /** Unions all the sets. */
  collect<T, B>(mapping: (t: T) => aset<B>, set: aset<T>): aset<B> {
    return ofRef(
      AVal.map(
        (values) =>
          HashSetOps.collect(
            (s) => mapping(s).content.getValue(AdaptiveToken.top),
            values,
          ),
        set.content,
      ),
    );
  },
  ofAVal<T>(value: aval<Iterable<T>>): aset<T> {
    const content = AVal.map((v) => HashSet.ofSeq(v), value);
    return ofRef(content);
  },
  bind<A, B>(mapping: (a: A) => aset<B>, value: aval<A>): aset<B> {
    const content = AVal.bind((v) => mapping(v).content, value);
    return ofRef(content);
  },
  flattenA<T>(set: aset<aval<T>>): aset<T> {
    return ofRef(
      AVal.map(
        (s) => s.map((r) => r.getValue(AdaptiveToken.top)),
        set.content,
      ),
    );
  },
  mapA<T, B>(mapping: (t: T) => aval<B>, set: aset<T>): aset<B> {
    return ASet.flattenA(ASet.map(mapping, set));
  },
  chooseA<T, B>(
    mapping: (t: T) => aval<B | undefined>,
    set: aset<T>,
  ): aset<B> {
    return ASet.choose((x: B | undefined) => x, ASet.flattenA(ASet.map(mapping, set)));
  },
  filterA<T>(predicate: (t: T) => aval<boolean>, set: aset<T>): aset<T> {
    return ASet.chooseA(
      (a: T) =>
        AVal.map((b) => (b ? a : undefined), predicate(a)),
      set,
    );
  },
  foldHalfGroup<S, A>(
    add: (s: S, a: A) => S,
    _trySubtract: (s: S, a: A) => S | undefined,
    zero: S,
    set: aset<A>,
  ): aval<S> {
    return AVal.map((s) => s.fold(add, zero), set.content);
  },
  foldGroup<S, A>(
    add: (s: S, a: A) => S,
    _sub: (s: S, a: A) => S,
    zero: S,
    set: aset<A>,
  ): aval<S> {
    return AVal.map((s) => s.fold(add, zero), set.content);
  },
  fold<S, A>(add: (s: S, a: A) => S, zero: S, set: aset<A>): aval<S> {
    return AVal.map((s) => s.fold(add, zero), set.content);
  },
  sum(set: aset<number>): aval<number> {
    return ASet.foldGroup<number, number>((s, a) => s + a, (s, a) => s - a, 0, set);
  },
  product(set: aset<number>): aval<number> {
    return ASet.foldGroup<number, number>((s, a) => s * a, (s, a) => s / a, 1, set);
  },
};
