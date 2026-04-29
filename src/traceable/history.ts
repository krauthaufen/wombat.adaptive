// Port of FSharp.Data.Adaptive Traceable/History.fs
//
// History and HistoryReader are the central machinery for traceable
// adaptive datatypes. A History either depends on an upstream
// IOpReader (in which case its state is fed by the reader), or stands
// alone and is mutated via Perform (e.g. cset/cmap/clist).
//
// Each reader created on the History remembers a RelevantNode pointing
// into a linked list of "versions". When the reader pulls deltas, the
// History walks the version chain forward, merging the ops that
// happened since the reader last looked. Nodes that no live reader
// references are pruned so old versions don't pile up.
//
// PORT NOTE — locks: F# uses `lock x (fun () -> ...)` around `Perform`
// and `PerformUnsafe` to serialise concurrent transactions. JS is
// single-threaded — locks dropped.
//
// PORT NOTE — AbstractDirtyReader uses a `System.Collections.Generic.HashSet<'T>`
// for the "dirty inputs since last evaluation" set. The TS port uses
// the JS native `Set<T>`.

import { AdaptiveObject, ConstantObject } from "../core/adaptiveObject.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import { markOutdated } from "../core/transaction.js";
import type { IAdaptiveObject } from "../core/types.js";
import type { Traceable } from "./traceable.js";

// ---------------------------------------------------------------------------
// IOpReader interfaces
// ---------------------------------------------------------------------------

/**
 * An adaptive reader that allows pulling delta-operations since the
 * last evaluation.
 */
export interface IOpReader<Delta> extends IAdaptiveObject {
  /** Dependency-aware evaluation of the reader. */
  getChanges(token: AdaptiveToken): Delta;
}

/**
 * An adaptive reader that allows pulling operations and also exposes
 * its current state.
 */
export interface IOpReaderWithState<State, Delta> extends IOpReader<Delta> {
  /** The Traceable instance for the reader. */
  readonly trace: Traceable<State, Delta>;
  /**
   * The latest state of the reader. Updated after each evaluation
   * (`getChanges`).
   */
  readonly state: State;
}

// ---------------------------------------------------------------------------
// AbstractReader<Delta>: base for IOpReader<Delta>
// ---------------------------------------------------------------------------

/** Abstract base class for implementing `IOpReader<Delta>`. */
export abstract class AbstractReader<Delta>
  extends AdaptiveObject
  implements IOpReader<Delta>
{
  protected readonly _empty: Delta;

  constructor(empty: Delta) {
    super();
    this._empty = empty;
  }

  /** Adaptively compute deltas. */
  abstract compute(token: AdaptiveToken): Delta;

  /**
   * Applies the delta to the current state and returns the
   * 'effective' delta. Default: identity.
   */
  applyOp(op: Delta): Delta {
    return op;
  }

  getChanges(token: AdaptiveToken): Delta {
    return this.evaluateAlways(token, (tok) => {
      if (this.outOfDate) {
        return this.applyOp(this.compute(tok));
      }
      return this._empty;
    });
  }
}

/** Abstract base class for implementing `IOpReader<State, Delta>`. */
export abstract class AbstractStatefulReader<State, Delta>
  extends AbstractReader<Delta>
  implements IOpReaderWithState<State, Delta>
{
  readonly trace: Traceable<State, Delta>;
  protected _state: State;

  constructor(trace: Traceable<State, Delta>) {
    super(trace.tmonoid.mempty);
    this.trace = trace;
    this._state = trace.tempty;
  }

  override applyOp(op: Delta): Delta {
    const [s, eff] = this.trace.tapplyDelta(this._state, op);
    this._state = s;
    return eff;
  }

  get state(): State {
    return this._state;
  }
}

/**
 * Abstract base class for `IOpReader<Delta>` implementations that need
 * to know which inputs were dirtied since the last evaluation.
 */
export abstract class AbstractDirtyReader<TInput extends IAdaptiveObject, Delta>
  extends AdaptiveObject
  implements IOpReader<Delta>
{
  protected readonly _empty: Delta;
  private readonly _take: (tag: unknown) => boolean;
  private _dirty: Set<TInput> = new Set();

  constructor(monoid: { mempty: Delta }, take: (tag: unknown) => boolean) {
    super();
    this._empty = monoid.mempty;
    this._take = take;
  }

  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    if (this._take(o.tag)) {
      // The cast assumes the user-supplied `take` only returns true for
      // objects of type TInput; matches the F# pattern-match guard.
      this._dirty.add(o as TInput);
    }
  }

  abstract compute(token: AdaptiveToken, dirty: Set<TInput>): Delta;

  applyOp(op: Delta): Delta {
    return op;
  }

  getChanges(token: AdaptiveToken): Delta {
    return this.evaluateAlways(token, (tok) => {
      if (this.outOfDate) {
        const dirty = this._dirty;
        this._dirty = new Set();
        return this.applyOp(this.compute(tok, dirty));
      }
      return this._empty;
    });
  }
}

// ---------------------------------------------------------------------------
// History internals
// ---------------------------------------------------------------------------

/**
 * Linked-list node representing a "version" in the History. Holds the
 * accumulated ops since the previous version, the base state at this
 * version, and a refcount tracking how many readers still depend on
 * it.
 */
class RelevantNode<State, Delta> {
  prev: WeakRef<RelevantNode<State, Delta>> | null;
  next: RelevantNode<State, Delta> | null;
  refCount: number;
  baseState: State;
  value: Delta;

  constructor(
    prev: WeakRef<RelevantNode<State, Delta>> | null,
    baseState: State,
    value: Delta,
    next: RelevantNode<State, Delta> | null,
  ) {
    this.prev = prev;
    this.next = next;
    this.refCount = 0;
    this.baseState = baseState;
    this.value = value;
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * History and HistoryReader are the central machinery for traceable
 * adaptive datatypes. A History either tracks an upstream
 * `IOpReader<Delta>` (passing its deltas through), or stands alone
 * and is mutated imperatively via `perform`.
 */
export class History<State, Delta> extends AdaptiveObject {
  private readonly _t: Traceable<State, Delta>;
  private readonly _input:
    | { value: IOpReader<Delta> | null; create: () => IOpReader<Delta> }
    | null;
  private readonly _finalize: (op: Delta) => void;
  private _state: State;
  private _last: WeakRef<RelevantNode<State, Delta>> | null = null;
  private _appendCounter = 0;

  /**
   * @internal Use one of the static `History.create*` factories or the
   * `ofReader` helper.
   */
  constructor(
    input:
      | { value: IOpReader<Delta> | null; create: () => IOpReader<Delta> }
      | null,
    trace: Traceable<State, Delta>,
    finalize: (op: Delta) => void,
  ) {
    super();
    this._t = trace;
    this._input = input;
    this._finalize = finalize;
    this._state = trace.tempty;
  }

  /** Convenience: history without an upstream reader. */
  static create<State, Delta>(
    trace: Traceable<State, Delta>,
    finalize?: (op: Delta) => void,
  ): History<State, Delta> {
    return new History<State, Delta>(null, trace, finalize ?? (() => {}));
  }

  /** Convenience: history fed by an upstream reader. */
  static ofReader<State, Delta>(
    trace: Traceable<State, Delta>,
    newReader: () => IOpReader<Delta>,
    finalize?: (op: Delta) => void,
  ): History<State, Delta> {
    return new History<State, Delta>(
      { value: null, create: newReader },
      trace,
      finalize ?? (() => {}),
    );
  }

  /** The current state of the history. */
  get state(): State {
    return this._state;
  }

  /** The traceable instance used by the history. */
  get trace(): Traceable<State, Delta> {
    return this._t;
  }

  // ----- internal helpers -----

  private getPrev(
    node: RelevantNode<State, Delta>,
  ): RelevantNode<State, Delta> | null {
    if (node === null || node.prev === null) return null;
    const p = node.prev.deref();
    return p ?? null;
  }

  private getFirstAndSize():
    | { first: RelevantNode<State, Delta>; size: number }
    | null {
    if (this._last === null) return null;
    const top = this._last.deref();
    if (top === undefined) return null;
    let first = top;
    let size = this._t.tsize(first.value);
    let prev = this.getPrev(first);
    while (prev !== null) {
      size += this._t.tsize(prev.value);
      first = prev;
      prev = this.getPrev(first);
    }
    return { first, size };
  }

  private pruneNode(
    shouldPrune: (s: State, n: number) => boolean,
    totalDeltaSize: number,
    first: RelevantNode<State, Delta> | null,
  ): void {
    let cur = first;
    let total = totalDeltaSize;
    while (cur !== null && shouldPrune(cur.baseState, total)) {
      const size = this._t.tsize(cur.value);
      const next = cur.next;
      cur.refCount = -1;
      if (cur.next === null) this._last = null;
      else cur.next.prev = null;
      cur.next = null;
      cur.prev = null;
      cur.baseState = undefined as unknown as State;
      cur.value = undefined as unknown as Delta;
      cur = next;
      total = total - size;
    }
  }

  private prune(): void {
    if (this._appendCounter > 100) {
      this._appendCounter = 0;
      const sp = this._t.tprune;
      if (sp !== undefined) {
        const fs = this.getFirstAndSize();
        if (fs !== null) this.pruneNode(sp, fs.size, fs.first);
      }
    } else {
      this._appendCounter += 1;
    }
  }

  /**
   * Append `op` to the history. Returns whether the op effectively
   * changed the state.
   */
  private append(op: Delta): boolean {
    if (this._t.tmonoid.misEmpty(op)) return false;
    const [s, eff] = this._t.tapplyDelta(this._state, op);
    this._state = s;
    if (this._t.tmonoid.misEmpty(eff)) return false;

    if (this._last !== null) {
      const lv = this._last.deref();
      if (lv !== undefined) {
        // last is alive — append our op
        lv.value = this._t.tmonoid.mappend(lv.value, eff);
      } else {
        this._last = null;
        this._finalize(eff);
      }
    } else {
      this._last = null;
      this._finalize(eff);
    }
    this.prune();
    return true;
  }

  /** Same as append but trusts the caller-provided new state. */
  private appendUnsafe(newState: State, op: Delta): boolean {
    this._state = newState;
    if (this._t.tmonoid.misEmpty(op)) return false;
    if (this._last !== null) {
      const lv = this._last.deref();
      if (lv !== undefined) {
        lv.value = this._t.tmonoid.mappend(lv.value, op);
      } else {
        this._last = null;
        this._finalize(op);
      }
    } else {
      this._last = null;
      this._finalize(op);
    }
    this.prune();
    return true;
  }

  private addRefToLast(): RelevantNode<State, Delta> {
    if (this._last !== null) {
      const lv = this._last.deref();
      if (lv !== undefined) {
        if (this._t.tmonoid.misEmpty(lv.value)) {
          lv.refCount += 1;
          return lv;
        }
        const n = new RelevantNode<State, Delta>(
          this._last,
          this._state,
          this._t.tmonoid.mempty,
          null,
        );
        lv.next = n;
        this._last = new WeakRef(n);
        n.refCount = 1;
        return n;
      }
    }
    const n = new RelevantNode<State, Delta>(
      null,
      this._state,
      this._t.tmonoid.mempty,
      null,
    );
    n.refCount = 1;
    this._last = new WeakRef(n);
    return n;
  }

  private mergeIntoPrev(
    node: RelevantNode<State, Delta>,
  ): { ops: Delta; next: RelevantNode<State, Delta> | null } {
    if (node.refCount === 1) {
      const res = node.value;
      const next = node.next;
      const prev = node.prev;
      this._finalize(node.value);
      node.value = undefined as unknown as Delta;
      node.prev = null;
      node.next = null;
      node.refCount = -1;
      if (next === null) this._last = prev;
      else next.prev = prev;
      if (prev !== null) {
        const prevValue = prev.deref();
        if (prevValue !== undefined) {
          prevValue.next = next;
          prevValue.value = this._t.tmonoid.mappend(prevValue.value, res);
        }
      }
      return { ops: res, next };
    }
    node.refCount -= 1;
    return { ops: node.value, next: node.next };
  }

  private isInvalid(
    node: RelevantNode<State, Delta> | null,
  ): node is null | (RelevantNode<State, Delta> & { refCount: -1 }) {
    return node === null || node.refCount < 0;
  }

  private update(token: AdaptiveToken): void {
    if (this.outOfDate) {
      if (this._input !== null) {
        if (this._input.value === null) {
          this._input.value = this._input.create();
        }
        const v = this._input.value.getChanges(token);
        this.append(v);
      }
    }
  }

  /**
   * Imperatively apply a delta to the history. The current
   * transaction must already be set; the call marks the History
   * outdated which propagates to dependent readers.
   */
  perform(op: Delta): boolean {
    const changed = this.append(op);
    if (changed) {
      markOutdated(this);
      return true;
    }
    return false;
  }

  /**
   * Imperative update where the caller already knows the new state.
   * Used by `ChangeableHashSet.updateTo` and friends.
   */
  performUnsafe(newState: State, op: Delta): boolean {
    const changed = this.appendUnsafe(newState, op);
    if (changed) {
      markOutdated(this);
      return true;
    }
    return false;
  }

  /**
   * @internal Used by HistoryReader to pull the operations since the
   * old RelevantNode. The reader provides its own latest state so the
   * history can recompute the delta if it had to drop the cached
   * version.
   */
  read(
    token: AdaptiveToken,
    old: RelevantNode<State, Delta> | null,
    oldState: State,
  ): { node: RelevantNode<State, Delta>; ops: Delta } {
    return this.evaluateAlways(token, (tok) => {
      this.update(tok);
      if (this.isInvalid(old)) {
        const ops = this._t.tcomputeDelta(oldState, this._state);
        const node = this.addRefToLast();
        return { node, ops };
      }
      let res = this._t.tmonoid.mempty;
      let current: RelevantNode<State, Delta> | null = old;
      while (current !== null) {
        const r = this.mergeIntoPrev(current);
        res = this._t.tmonoid.mappend(res, r.ops);
        current = r.next;
        if (current !== null) current.refCount += 1;
      }
      const node = this.addRefToLast();
      return { node, ops: res };
    });
  }

  /**
   * Adaptively gets the history's current state. Used to expose
   * `Content` as `aval<State>`.
   */
  getValue(token: AdaptiveToken): State {
    return this.evaluateAlways(token, (tok) => {
      this.update(tok);
      return this._state;
    });
  }

  /** Creates a new reader on this history. */
  newReader(): IOpReaderWithState<State, Delta> {
    return new HistoryReader<State, Delta>(this);
  }

  /**
   * Creates a new reader projecting into a different traceable shape
   * via the given mapping (called per state-and-delta).
   */
  newViewReader<ViewState, ViewDelta>(
    trace: Traceable<ViewState, ViewDelta>,
    mapping: (state: State, delta: Delta) => ViewDelta,
  ): IOpReaderWithState<ViewState, ViewDelta> {
    return new HistoryViewReader<State, Delta, ViewState, ViewDelta>(
      this,
      mapping,
      trace,
    );
  }
}

// ---------------------------------------------------------------------------
// HistoryReader
// ---------------------------------------------------------------------------

class HistoryReader<State, Delta>
  extends AdaptiveObject
  implements IOpReaderWithState<State, Delta>
{
  private readonly _h: History<State, Delta>;
  private readonly _trace: Traceable<State, Delta>;
  private _node: RelevantNode<State, Delta> | null = null;
  private _state: State;

  constructor(h: History<State, Delta>) {
    super();
    this._h = h;
    this._trace = h.trace;
    this._state = this._trace.tempty;
  }

  get trace(): Traceable<State, Delta> {
    return this._trace;
  }
  get state(): State {
    return this._state;
  }

  getChanges(token: AdaptiveToken): Delta {
    return this.evaluateAlways(token, (tok) => {
      if (this.outOfDate) {
        const r = this._h.read(tok, this._node, this._state);
        this._node = r.node;
        this._state = this._h.state;
        return r.ops;
      }
      return this._trace.tmonoid.mempty;
    });
  }
}

class HistoryViewReader<State, Delta, ViewState, ViewDelta>
  extends AdaptiveObject
  implements IOpReaderWithState<ViewState, ViewDelta>
{
  private readonly _h: History<State, Delta>;
  private readonly _mapping: (s: State, d: Delta) => ViewDelta;
  readonly trace: Traceable<ViewState, ViewDelta>;
  private _node: RelevantNode<State, Delta> | null = null;
  private _state: State;
  private _viewState: ViewState;

  constructor(
    h: History<State, Delta>,
    mapping: (s: State, d: Delta) => ViewDelta,
    trace: Traceable<ViewState, ViewDelta>,
  ) {
    super();
    this._h = h;
    this._mapping = mapping;
    this.trace = trace;
    this._state = h.trace.tempty;
    this._viewState = trace.tempty;
  }

  get state(): ViewState {
    return this._viewState;
  }

  getChanges(token: AdaptiveToken): ViewDelta {
    return this.evaluateAlways(token, (tok) => {
      if (this.outOfDate) {
        const r = this._h.read(tok, this._node, this._state);
        this._node = r.node;
        this._state = this._h.state;
        const vops = this._mapping(this._state, r.ops);
        const [s, eff] = this.trace.tapplyDelta(this._viewState, vops);
        this._viewState = s;
        return eff;
      }
      return this.trace.tmonoid.mempty;
    });
  }
}

// ---------------------------------------------------------------------------
// Constant / empty readers (shared utilities)
// ---------------------------------------------------------------------------

/** A reader that always emits the empty delta. */
export class EmptyReader<State, Delta>
  extends ConstantObject
  implements IOpReaderWithState<State, Delta>
{
  readonly trace: Traceable<State, Delta>;
  constructor(trace: Traceable<State, Delta>) {
    super();
    this.trace = trace;
  }
  get state(): State {
    return this.trace.tempty;
  }
  getChanges(_token: AdaptiveToken): Delta {
    return this.trace.tmonoid.mempty;
  }
}

/**
 * A reader that emits a constant delta on the first pull and the
 * empty delta thereafter. Lazy in both `ops` and `finalState`.
 */
export class ConstantReader<State, Delta>
  extends ConstantObject
  implements IOpReaderWithState<State, Delta>
{
  readonly trace: Traceable<State, Delta>;
  private readonly _ops: () => Delta;
  private readonly _finalState: () => State;
  private _state: State;
  private _initial = true;

  constructor(
    trace: Traceable<State, Delta>,
    ops: () => Delta,
    finalState: () => State,
  ) {
    super();
    this.trace = trace;
    this._ops = ops;
    this._finalState = finalState;
    this._state = trace.tempty;
  }

  get state(): State {
    return this._state;
  }

  getChanges(_token: AdaptiveToken): Delta {
    if (this._initial) {
      this._initial = false;
      this._state = this._finalState();
      return this._ops();
    }
    return this.trace.tmonoid.mempty;
  }
}
