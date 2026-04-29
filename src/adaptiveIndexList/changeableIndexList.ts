// Port of FSharp.Data.Adaptive AdaptiveIndexList/ChangeableIndexList.fs

import { AVal, type aval } from "../adaptiveValue/adaptiveValue.js";
import { transactIfNecessary } from "../core/transaction.js";
import {
  type Index,
  indexZero,
} from "../datastructures/index.js";
import { IndexList } from "../datastructures/indexList.js";
import {
  IndexListDelta,
  IndexListDeltaExt,
} from "../datastructures/indexListDelta.js";
import {
  ElementSet,
  ElementRemove,
} from "../datastructures/operations.js";
import { indexListTrace } from "../traceable/indexListTraceable.js";
import { History } from "../traceable/history.js";
import { AbstractAlist, type IIndexListReader } from "./adaptiveIndexList.js";

/**
 * Changeable adaptive list that allows mutation by user-code and
 * implements `alist`.
 */
export class ChangeableIndexList<T> extends AbstractAlist<T> implements Iterable<T> {
  override readonly isConstant = false;
  override readonly history: History<IndexList<T>, IndexListDelta<T>>;
  override readonly content: aval<IndexList<T>>;

  constructor(initial?: IndexList<T> | Iterable<T>) {
    super();
    const init =
      initial === undefined
        ? IndexList.empty<T>()
        : initial instanceof IndexList
          ? initial
          : IndexList.ofSeq<T>(initial);

    this.history = History.create(indexListTrace<T>());
    if (!init.isEmpty) {
      const delta = IndexListDeltaExt.computeDelta(IndexList.empty<T>(), init);
      this.history.perform(delta);
    }
    const hist = this.history;
    this.content = AVal.custom((tok) => {
      hist.getValue(tok);
      return hist.state;
    });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Synchronous (untracked) entry count. */
  get currentCount(): number {
    return this.history.state.count;
  }
  /** Synchronous (untracked) emptiness check. */
  get currentIsEmpty(): boolean {
    return this.history.state.isEmpty;
  }
  get minIndex(): Index {
    return this.history.state.isEmpty ? indexZero : this.history.state.minIndex;
  }
  get maxIndex(): Index {
    return this.history.state.isEmpty ? indexZero : this.history.state.maxIndex;
  }

  /** Get/set the entire current state as IndexList. */
  get value(): IndexList<T> {
    return this.history.state;
  }
  set value(v: IndexList<T>) {
    this.updateTo(v);
  }

  /** Synchronous (untracked) lookup by Index. */
  tryGetNow(index: Index): T | undefined {
    return this.history.state.tryGetByIndex(index);
  }
  /** Synchronous (untracked) lookup by position. */
  tryAtNow(pos: number): T | undefined {
    return this.history.state.tryGetByPosition(pos);
  }
  tryGetIndex(pos: number): Index | undefined {
    const e = this.history.state.content.itemV(pos);
    return e === undefined ? undefined : e[0];
  }

  /** Indexed access by position. */
  itemAt(pos: number): T {
    const v = this.tryAtNow(pos);
    if (v === undefined) throw new Error(`Index out of range: ${pos}`);
    return v;
  }

  /** Indexed access by Index key. */
  get(index: Index): T {
    const v = this.tryGetNow(index);
    if (v === undefined)
      throw new Error(`Index not present: ${index.toString()}`);
    return v;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Performs the given operations on the list. */
  perform(operations: IndexListDelta<T>): void {
    if (!operations.isEmpty) this.history.perform(operations);
  }

  /** Append `element`, returning its new Index. */
  add(element: T): Index {
    const newList = this.history.state.add(element);
    const newIndex = newList.maxIndex;
    this.history.perform(IndexListDelta.empty<T>().add(newIndex, ElementSet(element)));
    return newIndex;
  }

  addRange(elements: Iterable<T>): void {
    for (const e of elements) this.add(e);
  }

  /** Prepend `element`, returning its new Index. */
  prepend(element: T): Index {
    const newList = this.history.state.prepend(element);
    const newIndex = newList.minIndex;
    this.history.perform(IndexListDelta.empty<T>().add(newIndex, ElementSet(element)));
    return newIndex;
  }

  /** Inserts at the given position. */
  insertAt(pos: number, element: T): Index {
    const cur = this.history.state;
    if (pos <= 0) return this.prepend(element);
    if (pos >= cur.count) return this.add(element);
    const before = cur.content.itemV(pos - 1)![0];
    const after = cur.content.itemV(pos)![0];
    const newIndex = before.between(after);
    this.history.perform(
      IndexListDelta.empty<T>().add(newIndex, ElementSet(element)),
    );
    return newIndex;
  }

  /** Inserts directly after the given Index. */
  insertAfter(reference: Index, element: T): Index {
    const newIndex = reference.after();
    this.history.perform(
      IndexListDelta.empty<T>().add(newIndex, ElementSet(element)),
    );
    return newIndex;
  }

  /** Inserts directly before the given Index. */
  insertBefore(reference: Index, element: T): Index {
    const newIndex = reference.before();
    this.history.perform(
      IndexListDelta.empty<T>().add(newIndex, ElementSet(element)),
    );
    return newIndex;
  }

  /** Removes the entry by Index. Returns whether it existed. */
  remove(index: Index): boolean {
    if (this.history.state.tryGetByIndex(index) === undefined) return false;
    return this.history.perform(
      IndexListDelta.empty<T>().add(index, ElementRemove),
    );
  }

  /** Removes by position. Returns the removed Index, or throws. */
  removeAt(pos: number): Index {
    const e = this.history.state.content.itemV(pos);
    if (e === undefined) throw new Error(`Index out of range: ${pos}`);
    this.history.perform(
      IndexListDelta.empty<T>().add(e[0], ElementRemove),
    );
    return e[0];
  }

  /** Replaces the value at an Index. */
  set(index: Index, value: T): void {
    this.history.perform(
      IndexListDelta.empty<T>().add(index, ElementSet(value)),
    );
  }

  /** Replaces the value at a position. */
  setAt(pos: number, value: T): void {
    const e = this.history.state.content.itemV(pos);
    if (e === undefined) throw new Error(`Index out of range: ${pos}`);
    this.set(e[0], value);
  }

  clear(): void {
    if (!this.history.state.isEmpty) {
      const ops = IndexListDeltaExt.computeDelta(
        this.history.state,
        IndexList.empty<T>(),
      );
      this.history.perform(ops);
    }
  }

  /** Sets the current state as IndexList. Returns whether anything changed. */
  updateTo(target: IndexList<T>): boolean {
    if (Object.is(this.history.state, target)) return false;
    const delta = IndexListDeltaExt.computeDelta(this.history.state, target);
    if (delta.isEmpty) return false;
    return this.history.performUnsafe(target, delta);
  }

  /** Sets state from an array (rebuilds an IndexList). */
  updateToArray(values: T[]): boolean {
    return this.updateTo(IndexList.ofArray(values));
  }

  override getReader(): IIndexListReader<T> {
    return this.history.newReader();
  }

  *[Symbol.iterator](): IterableIterator<T> {
    yield* this.history.state;
  }

  override toString(): string {
    return `clist [${[...this.history.state.toListIndexed().slice(0, 5).map(([_, v]) => String(v))].join("; ")}${this.currentCount > 5 ? "; ..." : ""}]`;
  }
}

export type clist<T> = ChangeableIndexList<T>;

export function clist<T>(
  initial?: IndexList<T> | Iterable<T>,
): ChangeableIndexList<T> {
  return new ChangeableIndexList<T>(initial);
}

export const ChangeableIndexListOps = {
  empty: <T>() => new ChangeableIndexList<T>(),
  ofSeq: <T>(s: Iterable<T>) => new ChangeableIndexList<T>(s),
  ofIndexList: <T>(l: IndexList<T>) => new ChangeableIndexList<T>(l),
  add: <T>(c: ChangeableIndexList<T>, v: T) =>
    transactIfNecessary(() => c.add(v)),
  prepend: <T>(c: ChangeableIndexList<T>, v: T) =>
    transactIfNecessary(() => c.prepend(v)),
  remove: <T>(c: ChangeableIndexList<T>, i: Index) =>
    transactIfNecessary(() => c.remove(i)),
  removeAt: <T>(c: ChangeableIndexList<T>, p: number) =>
    transactIfNecessary(() => c.removeAt(p)),
  clear: <T>(c: ChangeableIndexList<T>) =>
    transactIfNecessary(() => c.clear()),
  updateTo: <T>(c: ChangeableIndexList<T>, l: IndexList<T>) =>
    transactIfNecessary(() => c.updateTo(l)),
  perform: <T>(c: ChangeableIndexList<T>, ops: IndexListDelta<T>) =>
    transactIfNecessary(() => c.perform(ops)),
};
