// Port of FSharp.Data.Adaptive.Reference/AdaptiveIndexList.fs

import { IndexList } from "../datastructures/indexList.js";
import {
  IndexListDelta,
  IndexListDeltaExt,
} from "../datastructures/indexListDelta.js";
import type { Index } from "../datastructures/index.js";
import {
  AVal,
  AdaptiveToken,
  type aval,
} from "./adaptiveValue.js";
import type { IOpReaderWithState } from "./adaptiveHashSet.js";

/** The reference implementation for IIndexListReader. */
export type IIndexListReader<T> = IOpReaderWithState<
  IndexList<T>,
  IndexListDelta<T>
>;

/** The reference implementation for alist. */
export interface alist<T> {
  getReader(): IIndexListReader<T>;
  readonly content: aval<IndexList<T>>;
}

/** A simple reader using `IndexList.computeDelta` for getting deltas. */
class AListReader<T> implements IIndexListReader<T> {
  private _last: IndexList<T> = IndexList.empty<T>();
  private readonly _list: alist<T>;
  constructor(list: alist<T>) {
    this._list = list;
  }
  get state(): IndexList<T> {
    return this._last;
  }
  getChanges(t: AdaptiveToken): IndexListDelta<T> {
    const c = this._list.content.getValue(t);
    const ops = IndexListDeltaExt.computeDelta<T>(this._last, c);
    this._last = c;
    return ops;
  }
}

/** A reference implementation for clist. */
export class ChangeableIndexList<T> implements alist<T> {
  private _content: IndexList<T>;
  readonly content: aval<IndexList<T>>;

  constructor(value?: IndexList<T> | Iterable<T>) {
    this._content =
      value === undefined
        ? IndexList.empty<T>()
        : value instanceof IndexList
          ? value
          : IndexList.ofSeq<T>(value);
    this.content = { getValue: () => this._content };
  }

  get value(): IndexList<T> {
    return this._content;
  }
  set value(v: IndexList<T>) {
    this._content = v;
  }

  getReader(): IIndexListReader<T> {
    return new AListReader<T>(this);
  }
}

export type clist<T> = ChangeableIndexList<T>;

function ofRef<T>(r: aval<IndexList<T>>): alist<T> {
  const self: alist<T> = {
    content: r,
    getReader: () => new AListReader<T>(self),
  };
  return self;
}

/** Functional operators for the alist reference-implementation. */
export const AList = {
  empty<T>(): alist<T> {
    return ofRef(AVal.constant(IndexList.empty<T>()));
  },
  single<T>(value: T): alist<T> {
    return ofRef(AVal.constant(IndexList.single(value)));
  },
  ofSeq<T>(values: Iterable<T>): alist<T> {
    return ofRef(AVal.constant(IndexList.ofSeq(values)));
  },
  ofList<T>(values: T[]): alist<T> {
    return ofRef(AVal.constant(IndexList.ofList(values)));
  },
  ofArray<T>(values: T[]): alist<T> {
    return ofRef(AVal.constant(IndexList.ofArray(values)));
  },
  ofIndexList<T>(values: IndexList<T>): alist<T> {
    return ofRef(AVal.constant(values));
  },
  mapi<T1, T2>(
    mapping: (i: Index, t: T1) => T2,
    list: alist<T1>,
  ): alist<T2> {
    return ofRef(AVal.map((s) => s.map(mapping), list.content));
  },
  map<T1, T2>(mapping: (t: T1) => T2, list: alist<T1>): alist<T2> {
    return AList.mapi((_i, v) => mapping(v), list);
  },
  choosei<T1, T2>(
    mapping: (i: Index, t: T1) => T2 | undefined,
    list: alist<T1>,
  ): alist<T2> {
    return ofRef(AVal.map((s) => s.choose(mapping), list.content));
  },
  choose<T1, T2>(
    mapping: (t: T1) => T2 | undefined,
    list: alist<T1>,
  ): alist<T2> {
    return AList.choosei((_i, v) => mapping(v), list);
  },
  filteri<T>(
    predicate: (i: Index, t: T) => boolean,
    list: alist<T>,
  ): alist<T> {
    return ofRef(AVal.map((s) => s.filter(predicate), list.content));
  },
  filter<T>(predicate: (t: T) => boolean, list: alist<T>): alist<T> {
    return AList.filteri((_i, v) => predicate(v), list);
  },
  append<T>(l: alist<T>, r: alist<T>): alist<T> {
    return ofRef(
      AVal.map2((a, b) => IndexList.append(a, b), l.content, r.content),
    );
  },
  collecti<T1, T2>(
    mapping: (i: Index, t: T1) => alist<T2>,
    list: alist<T1>,
  ): alist<T2> {
    return ofRef(
      AVal.map((s) => {
        let out = IndexList.empty<T2>();
        for (const [i, v] of s.toListIndexed()) {
          for (const x of AVal.force(mapping(i, v).content)) {
            out = out.add(x);
          }
        }
        return out;
      }, list.content),
    );
  },
  collect<T1, T2>(
    mapping: (t: T1) => alist<T2>,
    list: alist<T1>,
  ): alist<T2> {
    return AList.collecti((_i, v) => mapping(v), list);
  },
  sortBy<T1, T2>(mapping: (t: T1) => T2, list: alist<T1>): alist<T1> {
    return ofRef(AVal.map((s) => s.sortBy(mapping), list.content));
  },
  sortWith<T>(
    compare: (a: T, b: T) => number,
    list: alist<T>,
  ): alist<T> {
    return ofRef(AVal.map((s) => s.sortWith(compare), list.content));
  },
  pairwise<T>(list: alist<T>): alist<[T, T]> {
    return ofRef(
      AVal.map((s) => {
        const arr = [...s];
        const out: Array<[T, T]> = [];
        for (let i = 0; i + 1 < arr.length; i++) {
          out.push([arr[i]!, arr[i + 1]!]);
        }
        return IndexList.ofArray(out);
      }, list.content),
    );
  },
  pairwiseCyclic<T>(list: alist<T>): alist<[T, T]> {
    return ofRef(
      AVal.map((s) => {
        const arr = [...s];
        const out: Array<[T, T]> = [];
        for (let i = 0; i < arr.length; i++) {
          out.push([arr[i]!, arr[(i + 1) % arr.length]!]);
        }
        return IndexList.ofArray(out);
      }, list.content),
    );
  },
};
