// Port of FSharp.Data.Adaptive Core/Transaction.fs
//
// PORT NOTE: F# `LockingExtensions` module (EnterWrite/ExitWrite/
// IsOutdatedCaller) is removed entirely — JS is single-threaded.
// `IsOutdatedCaller` was `Monitor.IsEntered o && o.OutOfDate`; the
// `Monitor.IsEntered` part is gone, so what remains is simply
// `o.OutOfDate`. Comments mark the spots where these used to live.
//
// PORT NOTE: F# `[<ThreadStatic>]` becomes a module-level let in TS
// (single-threaded JS, no thread-locality required).
//
// PORT NOTE: F# `AdaptiveSynchronizationContext` machinery is .NET WPF
// interop — entirely removed.

import type { IAdaptiveObject, OutputBuffer } from "./types.js";
import { TransactQueue } from "../utilities/priorityQueue.js";

// ---------------------------------------------------------------------------
// LevelChangedException
// ---------------------------------------------------------------------------

/**
 * When evaluating AdaptiveObjects inside a Transaction (aka eager
 * evaluation) their level might be inconsistent when attempting to
 * evaluate. Therefore the evaluation may raise this exception causing
 * the evaluation to be delayed to a later time in the Transaction.
 */
export class LevelChangedException extends Error {
  /** The new (effective) level of the IAdaptiveObject. */
  readonly newLevel: number;
  constructor(newLevel: number) {
    super(`LevelChanged: newLevel=${newLevel}`);
    this.name = "LevelChangedException";
    this.newLevel = newLevel;
  }
}

// ---------------------------------------------------------------------------
// IndirectOutputObject
// ---------------------------------------------------------------------------

/**
 * internal type used for properly handling of decorator objects
 * (as introduced in AVal.mapNonAdaptive). Note that it should never be
 * necessary to use this in user-code.
 */
export class IndirectOutputObject implements IAdaptiveObject {
  private _weak: WeakRef<IAdaptiveObject> | null = null;
  private readonly _real: WeakRef<IAdaptiveObject>;
  private readonly _decorator: IAdaptiveObject;
  private readonly _release: (o: IndirectOutputObject) => void;

  private constructor(
    real: WeakRef<IAdaptiveObject>,
    decorator: IAdaptiveObject,
    release: (o: IndirectOutputObject) => void,
  ) {
    this._real = real;
    this._decorator = decorator;
    this._release = release;
  }

  get tag(): unknown {
    return null;
  }
  set tag(_v: unknown) {
    /* no-op */
  }

  readonly isConstant = false;

  get weak(): WeakRef<IAdaptiveObject> {
    if (this._weak === null) {
      this._weak = new WeakRef<IAdaptiveObject>(this);
    }
    return this._weak;
  }

  get outputs(): never {
    // F# returned `Unchecked.defaultof<_>` (null). Hitting this is a
    // bug; there's no legitimate path that reads .outputs on an
    // IndirectOutputObject.
    throw new Error("IndirectOutputObject.outputs is not available");
  }

  mark(): boolean {
    return false;
  }
  allInputsProcessed(_t: unknown): void {}
  inputChanged(_t: unknown, _o: IAdaptiveObject): void {}

  get outOfDate(): boolean {
    return false;
  }
  set outOfDate(_v: boolean) {
    /* no-op */
  }

  get level(): number {
    const r = this._real.deref();
    return r !== undefined ? r.level : 0;
  }
  set level(v: number) {
    const r = this._real.deref();
    if (r !== undefined) r.level = v;
  }

  get real(): WeakRef<IAdaptiveObject> {
    return this._real;
  }
  get decorator(): IAdaptiveObject {
    return this._decorator;
  }

  release(): void {
    this._release(this);
  }

  static create(
    real: IAdaptiveObject,
    decorator: IAdaptiveObject,
    release: (o: IndirectOutputObject) => void,
  ): IndirectOutputObject {
    if (real instanceof IndirectOutputObject) return real;
    return new IndirectOutputObject(real.weak, decorator, release);
  }
}

// ---------------------------------------------------------------------------
// Module-level transaction state (was [<ThreadStatic>] on Transaction)
// ---------------------------------------------------------------------------

let _runningTransaction: Transaction | null = null;
let _currentTransaction: Transaction | null = null;

export function getRunningTransaction(): Transaction | null {
  return _runningTransaction;
}
export function setRunningTransaction(t: Transaction | null): void {
  _runningTransaction = t;
}
export function getCurrentBuiltTransaction(): Transaction | null {
  return _currentTransaction;
}
export function setCurrentBuiltTransaction(t: Transaction | null): void {
  _currentTransaction = t;
}

/** Indicates if inside a running Transaction. */
export function hasRunningTransaction(): boolean {
  return _runningTransaction !== null;
}

/**
 * Gets the level of the currently running Transaction or
 * Int32.MaxValue - 1 when no Transaction is running.
 */
export function runningTransactionLevel(): number {
  if (_runningTransaction !== null) {
    return _runningTransaction.currentLevel;
  }
  // F# uses Int32.MaxValue - 1
  return 0x7fffffff - 1;
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/**
 * Holds a set of adaptive objects which have been changed and shall
 * therefore be marked as outOfDate. Committing the transaction
 * propagates these changes into the dependency-graph, takes care of
 * the correct execution-order and (originally) acquired appropriate
 * locks for all objects affected.
 */
export class Transaction {
  private readonly _q = new TransactQueue<IAdaptiveObject>();
  private _current: IAdaptiveObject | null = null;
  private _currentLevel = 0;
  private _finalizers: (() => void)[] = [];
  private _outputs: OutputBuffer = {
    value: new Array(8).fill(undefined),
  };

  private runFinalizers(): void {
    const fs = this._finalizers;
    this._finalizers = [];
    for (const f of fs) f();
  }

  addFinalizer(f: () => void): void {
    this._finalizers.push(f);
  }

  isContained(e: IAdaptiveObject): boolean {
    return this._q.contains(e);
  }

  /** Gets the current Level the Transaction operates on. */
  get currentLevel(): number {
    return this._currentLevel;
  }

  /** Enqueues an adaptive object for marking. */
  enqueue(e: IAdaptiveObject): void {
    this._q.enqueue(e.level, e);
  }

  /** Gets the current AdaptiveObject being marked, or null. */
  get currentAdaptiveObject(): IAdaptiveObject | null {
    return this._current;
  }

  /**
   * Performs the entire marking process, causing all affected objects
   * to be made consistent with the enqueued changes.
   */
  commit(): void {
    // cache the currently running transaction (if any) and make
    // ourselves current.
    const old = _runningTransaction;
    _runningTransaction = this;
    let outputCount = 0;

    while (!this._q.isEmpty) {
      // dequeue the next element (having the minimal level)
      const { key: l, value: e } = this._q.dequeue();
      this._current = e;
      this._currentLevel = l;

      // F# original here checked `e.IsOutdatedCaller()` which combined
      // `Monitor.IsEntered o` with `o.OutOfDate`. Without locks this
      // collapses to just OutOfDate. Behaviour preserved: skip down
      // to InputChanged/Enqueue if already out-of-date.
      if (e.outOfDate) {
        e.allInputsProcessed(this);
        // fall through to outputs handling below
      } else {
        // F# original temporarily cleared RunningTransaction here as a
        // workaround for WPF SynchronizationContext lock interception.
        // Removed — no SyncContext in JS.
        // F# original: `e.EnterWrite()` here. Removed.
        try {
          outputCount = 0;

          // if the element is already outOfDate we do not traverse the
          // graph further.
          if (e.outOfDate) {
            e.allInputsProcessed(this);
          } else {
            // if the object's level has changed since it was added to
            // the queue we re-enqueue it with the new level.
            if (this._currentLevel !== e.level) {
              this._q.enqueue(e.level, e);
            } else {
              // however if the level is consistent we may proceed by
              // marking the object as outOfDate
              e.outOfDate = true;
              e.allInputsProcessed(this);

              try {
                // here mark and the callbacks are allowed to evaluate
                // the adaptive object but must expect any call to
                // AddOutput to raise a LevelChangedException whenever
                // a level has been changed
                if (e.mark()) {
                  // if everything succeeded we return all current
                  // outputs which will cause them to be enqueued
                  outputCount = e.outputs.consume(this._outputs);
                } else {
                  e.outOfDate = false;
                  // if Mark told us not to continue we're done here
                }
              } catch (ex) {
                if (ex instanceof LevelChangedException) {
                  // if the level was changed either by a callback or
                  // Mark we re-enqueue the object with the new level
                  // and mark it upToDate again (since it would
                  // otherwise not be processed again)
                  e.level = Math.max(e.level, ex.newLevel);
                  e.outOfDate = false;
                  this._q.enqueue(e.level, e);
                } else {
                  throw ex;
                }
              }
            }
          }
        } finally {
          // F# original: `e.ExitWrite()` here. Removed.
        }
      }

      // finally we enqueue all returned outputs
      const outputs = this._outputs.value;
      for (let i = 0; i < outputCount; i++) {
        const o = outputs[i];
        outputs[i] = undefined;
        if (o instanceof IndirectOutputObject) {
          const r = o.real.deref();
          if (r !== undefined) {
            r.inputChanged(this, o.decorator);
            this.enqueue(r);
          } else {
            o.release();
          }
        } else if (o !== undefined) {
          o.inputChanged(this, e);
          this.enqueue(o);
        }
      }
      outputCount = 0;

      this._current = null;
    }

    // when the commit is over we restore the old running transaction
    // (if any).
    _runningTransaction = old;
    this._currentLevel = 0;
  }

  /** Disposes the transaction running all of its finalizers. */
  dispose(): void {
    this.runFinalizers();
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (F# `module Transaction = ...`)
// ---------------------------------------------------------------------------

/**
 * Returns the currently running transaction or (if none)
 * the current transaction for the calling thread.
 */
export function getCurrentTransaction(): Transaction | null {
  if (_runningTransaction !== null) return _runningTransaction;
  if (_currentTransaction !== null) return _currentTransaction;
  return null;
}

export function useTransaction<T>(t: Transaction, action: () => T): T {
  const old = _currentTransaction;
  try {
    _currentTransaction = t;
    return action();
  } finally {
    _currentTransaction = old;
  }
}

export function makeCurrent(t: Transaction): { dispose(): void } {
  const old = _currentTransaction;
  _currentTransaction = t;
  return {
    dispose(): void {
      _currentTransaction = old;
    },
  };
}

// PORT NOTE: F# original has both `useTransaction` and `useCurrent` with
// identical bodies and a `// TODO: identical to useTransaction ?` comment.
// We export only `useTransaction`; `transact` below uses the same logic.

/**
 * Executes a function "inside" a newly created transaction and commits
 * the transaction.
 */
export function transact<T>(action: () => T): T {
  const t = new Transaction();
  try {
    const r = useTransaction(t, action);
    t.commit();
    return r;
  } finally {
    t.dispose();
  }
}

/**
 * Executes a function "inside" the current transaction or creates and
 * commits a new one whenever none was current.
 */
export function transactIfNecessary<T>(action: () => T): T {
  if (_currentTransaction !== null) return action();
  return transact(action);
}

// ---------------------------------------------------------------------------
// IAdaptiveObject helpers (F# extension methods MarkOutdated)
// ---------------------------------------------------------------------------

/**
 * Utility for marking an adaptive object as outOfDate. Will enqueue
 * the object on the current transaction and fail if no current
 * transaction can be found. However objects which are already
 * out-of-date (or have empty outputs) might be "marked" without a
 * transaction.
 */
export function markOutdated(x: IAdaptiveObject): void;
export function markOutdated(x: IAdaptiveObject, fin: () => void): void;
export function markOutdated(x: IAdaptiveObject, fin?: () => void): void {
  const t = getCurrentTransaction();
  if (t !== null) {
    t.enqueue(x);
    if (fin !== undefined) t.addFinalizer(fin);
  } else {
    // F# original: `lock x (fun () -> ...)`. Removed.
    if (x.outOfDate) {
      // already marked
    } else if (x.outputs.isEmpty) {
      x.outOfDate = true;
    } else {
      throw new Error("cannot mark object without transaction");
    }
    if (fin !== undefined) fin();
  }
}
