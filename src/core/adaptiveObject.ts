// Port of FSharp.Data.Adaptive Core/AdaptiveObject.fs
//
// PORT NOTE: F# uses `Monitor.Enter`/`Monitor.Exit` extensively in
// EvaluateAlways. JS is single-threaded — all locks are removed. Comments
// mark each location that originally held a lock. The level-checking and
// LevelChangedException machinery stays.
//
// PORT NOTE: F# `[<ThreadStatic>]` becomes a module-level let in TS
// (single-threaded JS, no thread-locality required).
//
// PORT NOTE: F# `AdaptiveSynchronizationContext` block at the end of the
// original file is .NET-specific WPF interop — not ported.

import { AdaptiveToken } from "./adaptiveToken.js";
import type { IAdaptiveObject, IWeakOutputSet } from "./types.js";
import { EmptyOutputSet, WeakOutputSet } from "./weakOutputSet.js";
import {
  hasRunningTransaction,
  LevelChangedException,
  runningTransactionLevel,
  transact,
} from "./transaction.js";

// ---------------------------------------------------------------------------
// AfterEvaluateCallbacks — module-level mutable list (F# was [<ThreadStatic>])
// ---------------------------------------------------------------------------

let _afterEvaluateCallbacks: (() => void)[] = [];

export const AfterEvaluateCallbacks = {
  get callbacks(): (() => void)[] {
    return _afterEvaluateCallbacks;
  },
  set callbacks(v: (() => void)[]) {
    _afterEvaluateCallbacks = v;
  },

  add(action: () => void): void {
    if (unsafeEvaluationDepth() <= 0) {
      transact(action);
    } else {
      _afterEvaluateCallbacks.push(action);
    }
  },

  run(): void {
    if (_afterEvaluateCallbacks.length === 0) return;
    const cbs = _afterEvaluateCallbacks;
    _afterEvaluateCallbacks = [];
    transact(() => {
      for (const cb of cbs) cb();
    });
  },
};

// ---------------------------------------------------------------------------
// Evaluation depth (module-level; was [<ThreadStatic>] on AdaptiveObject)
// ---------------------------------------------------------------------------

let _currentEvaluationDepth = 0;

export function unsafeEvaluationDepth(): number {
  return _currentEvaluationDepth;
}

export function setUnsafeEvaluationDepth(v: number): void {
  _currentEvaluationDepth = v;
}

// ---------------------------------------------------------------------------
// Level-checking flag (was static let on AdaptiveObject)
// ---------------------------------------------------------------------------

let _unsafePerformLevelChecking = true;

export function getUnsafePerformLevelChecking(): boolean {
  return _unsafePerformLevelChecking;
}
export function setUnsafePerformLevelChecking(v: boolean): void {
  _unsafePerformLevelChecking = v;
}

// ---------------------------------------------------------------------------
// AdaptiveObject — abstract base class for adaptive cells
// ---------------------------------------------------------------------------

/// Core implementation of IAdaptiveObject containing tools for evaluation
/// and locking.
//
// PORT NOTE: F# made the class `[<AbstractClass>]` with abstract members
// `MarkObject`/`AllInputProcessedObject`/`InputChangedObject` and bound
// the IAdaptiveObject interface methods to those. TS doesn't distinguish
// abstract from interface members, so we expose `mark`/`inputChanged`/
// `allInputsProcessed` directly as overridable methods. Default
// implementations match the F# defaults.
export class AdaptiveObject implements IAdaptiveObject {
  private _outOfDate = true;
  private _level = 0;
  private _outputs: WeakOutputSet = new WeakOutputSet();
  private _weak: WeakRef<IAdaptiveObject> | null = null;
  private _tag: unknown = null;

  /// See IAdaptiveObject.Weak
  get weak(): WeakRef<IAdaptiveObject> {
    // PORT NOTE: F# accepts a benign race here; in JS there's no race,
    // but the lazy-allocate-on-first-access pattern is still correct.
    if (this._weak === null) {
      this._weak = new WeakRef<IAdaptiveObject>(this);
    }
    return this._weak;
  }

  get outOfDate(): boolean {
    return this._outOfDate;
  }
  set outOfDate(v: boolean) {
    this._outOfDate = v;
  }

  get level(): number {
    return this._level;
  }
  set level(v: number) {
    this._level = v;
  }

  get outputs(): IWeakOutputSet {
    return this._outputs;
  }

  get tag(): unknown {
    return this._tag;
  }
  set tag(v: unknown) {
    this._tag = v;
  }

  readonly isConstant: boolean = false;

  /// Allows a specific implementation to evaluate the cell during the
  /// change propagation process.
  mark(): boolean {
    return true;
  }

  /// Gets called after all inputs of the object have been processed
  /// and directly before the object will be marked.
  allInputsProcessed(_t: unknown): void {
    /* default no-op */
  }

  /// Gets called whenever a current input of the object gets marked
  /// out of date.
  inputChanged(_t: unknown, _o: IAdaptiveObject): void {
    /* default no-op */
  }

  /// Utility function for evaluating an object even if it is not marked
  /// as outOfDate. Originally took care of locking; locks removed.
  evaluateAlways<T>(token: AdaptiveToken, f: (t: AdaptiveToken) => T): T {
    const caller = token.caller;
    const depth = unsafeEvaluationDepth();

    let res: T;
    // F# original: `Monitor.Enter x`. Removed.
    try {
      setUnsafeEvaluationDepth(depth + 1);

      // this evaluation is performed optimistically
      // meaning that the "top-level" object needs to be allowed to
      // pull at least one value on every path.
      // This property must therefore be maintained for every
      // path in the entire system.
      const r = f(token.withCaller(this));
      this._outOfDate = false;

      // if the object's level just got greater than or equal to
      // the level of the running transaction (if any) we raise an
      // exception since the evaluation could be inconsistent atm.
      // The only exception to that is the top-level object itself.
      const maxAllowedLevel =
        depth > 1
          ? runningTransactionLevel() - 1
          : runningTransactionLevel();

      if (_unsafePerformLevelChecking && this._level > maxAllowedLevel) {
        // all greater pulls would be from the future
        throw new LevelChangedException(this._level + depth);
      }

      res = r;

      if (caller !== null) {
        this._outputs.add(caller);
        caller.level = Math.max(caller.level, this._level + 1);
      }
    } catch (e) {
      setUnsafeEvaluationDepth(depth);
      // F# original: `Monitor.Exit x` here. Removed.
      throw e;
    }

    setUnsafeEvaluationDepth(depth);
    // F# original: `Monitor.Exit x` here. Removed.

    if (depth === 0 && caller === null && !hasRunningTransaction()) {
      AfterEvaluateCallbacks.run();
    }

    return res;
  }

  /// Utility function for evaluating an object if it is marked as
  /// outOfDate. If the object is actually outOfDate the given function
  /// is executed and otherwise the given default value is returned.
  evaluateIfNeeded<T>(
    token: AdaptiveToken,
    otherwise: T,
    f: (t: AdaptiveToken) => T,
  ): T {
    return this.evaluateAlways(token, (tok) => {
      if (this._outOfDate) return f(tok);
      return otherwise;
    });
  }

  /// Executes the given action after the (currently running)
  /// evaluation has finished (once).
  static runAfterEvaluate(action: () => void): void {
    AfterEvaluateCallbacks.add(action);
  }
}

// ---------------------------------------------------------------------------
// ConstantObject — IAdaptiveObject for constants (no outputs, never
// out-of-date, mark always false).
// ---------------------------------------------------------------------------

const _constantOutputs: IWeakOutputSet = new EmptyOutputSet();

export class ConstantObject implements IAdaptiveObject {
  private _weak: WeakRef<IAdaptiveObject> | null = null;

  get tag(): unknown {
    return null;
  }
  set tag(_v: unknown) {
    /* no-op */
  }

  readonly isConstant = true;

  get weak(): WeakRef<IAdaptiveObject> {
    if (this._weak === null) {
      this._weak = new WeakRef<IAdaptiveObject>(this);
    }
    return this._weak;
  }

  get outputs(): IWeakOutputSet {
    return _constantOutputs;
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
    return 0;
  }
  set level(_v: number) {
    /* no-op */
  }
}
