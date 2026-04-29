// Port of FSharp.Data.Adaptive Core/Callbacks.fs
//
// PORT NOTE: F# uses `ConditionalWeakTable<K,V>` for the per-object
// MultiCallbackObject cache. JS `WeakMap<K,V>` is the exact equivalent:
// keys must be objects, garbage-collected when unreachable, no
// enumeration. Direct mapping.
//
// PORT NOTE: F# uses `ConcurrentDictionary<int, WeakReference<...>>` for
// the per-callback set within a MultiCallbackObject (.NET) and
// `HashMap<int, WeakReference<...>>` (Fable). JS is single-threaded; we
// use a plain `Map<number, WeakRef<...>>`. Iteration semantics match the
// F# behaviour we rely on (entries removed during iteration are skipped;
// added-during-iteration entries may be visited, but the only mutation
// in `mark()` is removal).
//
// PORT NOTE: F# `GCHandle.Alloc(this)` is used to keep a CallbackDisposable
// alive when the user passed `makeGCRoot=true` (the non-weak case). JS
// has no equivalent primitive; we use a module-level `Set` of strongly-held
// disposables instead. Removed on dispose.
//
// PORT NOTE: F# `lock` calls are removed. Comments mark each location.

import type { IAdaptiveObject, IWeakOutputSet } from "./types.js";
import { EmptyOutputSet } from "./weakOutputSet.js";
import { LevelChangedException } from "./transaction.js";

// ---------------------------------------------------------------------------
// CallbackDisposable
// ---------------------------------------------------------------------------

/** PORT NOTE: module-level strong root set replacing F# `GCHandle.Alloc`. */
const _strongRoots: Set<CallbackDisposable> = new Set();

class CallbackDisposable {
  private _isDisposed = false;
  private _remove: () => void;
  private _callback: () => boolean;
  private readonly _isStrongRooted: boolean;

  constructor(
    remove: () => void,
    makeGCRoot: boolean,
    callback: () => boolean,
  ) {
    this._remove = remove;
    this._callback = callback;
    this._isStrongRooted = makeGCRoot;
    if (makeGCRoot) _strongRoots.add(this);
  }

  dispose(): void {
    if (!this._isDisposed) {
      this._isDisposed = true;
      this._remove();
      this._remove = () => {
        /* no-op */
      };
      this._callback = () => false;
      if (this._isStrongRooted) _strongRoots.delete(this);
    }
  }
}

/** Public disposable interface for callback subscriptions. */
export interface IDisposable {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// MultiCallbackObject
// ---------------------------------------------------------------------------

const _emptyOutputs: IWeakOutputSet = new EmptyOutputSet();

/** Represents an object providing callbacks in the dependency-tree. */
class MultiCallbackObject implements IAdaptiveObject {
  private readonly _table: WeakMap<IAdaptiveObject, MultiCallbackObject>;
  private _id = 0;
  private _level: number;
  private readonly _cbs: Map<number, WeakRef<() => boolean>> = new Map();
  private _obj: IAdaptiveObject | null;
  private _weak: WeakRef<IAdaptiveObject> | null = null;

  constructor(
    table: WeakMap<IAdaptiveObject, MultiCallbackObject>,
    obj: IAdaptiveObject,
  ) {
    this._table = table;
    this._obj = obj;
    this._level = obj.level + 1;
  }

  get tag(): unknown {
    return null;
  }
  set tag(_v: unknown) {
    /* no-op */
  }

  get isConstant(): boolean {
    return false;
  }

  get weak(): WeakRef<IAdaptiveObject> {
    if (this._weak === null) {
      this._weak = new WeakRef<IAdaptiveObject>(this);
    }
    return this._weak;
  }

  inputChanged(_t: unknown, _o: IAdaptiveObject): void {}
  allInputsProcessed(_t: unknown): void {}

  get outOfDate(): boolean {
    return false;
  }
  set outOfDate(_v: boolean) {
    /* no-op */
  }

  get outputs(): IWeakOutputSet {
    return _emptyOutputs;
  }

  get level(): number {
    return this._level;
  }
  set level(v: number) {
    this._level = v;
  }

  private newId(): number {
    this._id += 1;
    return this._id;
  }

  /**
   * this function checks to see if we need to release resources if
   * there are no active callbacks anymore
   */
  private check(): boolean {
    // we don't need a lock here because we are using obj being null to
    // indicate this is a dead object
    if (this._obj === null) return false;
    // F# original: `lock table (fun _ -> ...)`. Removed.
    if (this._cbs.size === 0) {
      // since there are no more live callbacks we'd like to release
      // this object
      this._obj.outputs.remove(this);
      // it doesn't matter if the table has an entry for us or not
      this._table.delete(this._obj);
      this._level = 0;
      this._obj = null;
      this._weak = null;
      return false;
    } else {
      return true;
    }
  }

  private removeId(id: number): void {
    // F# original: `lock x (fun () -> ...)`. Removed.
    this._cbs.delete(id);
    this.check();
  }

  /**
   * adds a callback to the object. The returned IDisposable removes
   * the callback. The `weak` parameter controls whether the callback
   * keeps itself alive (false → strong, true → weak).
   */
  subscribe(weak: boolean, cb: () => boolean): IDisposable {
    // F# original: `lock x (fun () -> ...)`. Removed.
    if (this._obj === null) {
      throw new Error("MultiCallbackObject.subscribe on a dead object");
    }
    if (this._cbs.size === 0) {
      this._obj.outputs.add(this);
    }
    const id = this.newId();
    const weakCallback = new WeakRef<() => boolean>(cb);
    this._cbs.set(id, weakCallback);

    const remove = () => this.removeId(id);
    return new CallbackDisposable(remove, !weak, cb);
  }

  mark(): boolean {
    // this loop allows us to move through the callbacks even if more
    // are being added; we check each callback to see if it is still
    // alive and then if we are to retain it after executing.
    const toRemove: number[] = [];
    for (const [k, cb] of this._cbs) {
      let keep: boolean;
      const target = cb.deref();
      if (target !== undefined) {
        try {
          keep = target();
        } catch {
          keep = false;
        }
      } else {
        keep = false;
      }
      if (!keep) toRemove.push(k);
    }
    for (const k of toRemove) this._cbs.delete(k);

    if (this.check()) {
      this._obj!.outputs.add(this);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public callback API
// ---------------------------------------------------------------------------

/** cache for MultiCallbackObjects per IAdaptiveObject */
const _callbackObjects: WeakMap<IAdaptiveObject, MultiCallbackObject> =
  new WeakMap();

/** utility getting/creating a MultiCallbackObject for the given IAdaptiveObject */
function setMultiCallback(
  o: IAdaptiveObject,
  weak: boolean,
  callback: () => boolean,
): IDisposable {
  // F# original: `lock callbackObjects (fun () -> ...)`. Removed.
  let cbo = _callbackObjects.get(o);
  if (cbo === undefined) {
    cbo = new MultiCallbackObject(_callbackObjects, o);
    _callbackObjects.set(o, cbo);
  }
  return cbo.subscribe(weak, callback);
}

/**
 * Registers a callback with the given object that will be executed
 * whenever the object gets marked out-of-date. Does not trigger when
 * the object is currently out-of-date. Returns a disposable for
 * removing the callback.
 */
export function addMarkingCallback(
  o: IAdaptiveObject,
  callback: () => void,
): IDisposable {
  return setMultiCallback(o, false, () => {
    callback();
    return true;
  });
}

/**
 * Same as addMarkingCallback but holds the callback weakly — if the
 * caller drops the reference, the callback is collected.
 */
export function addWeakMarkingCallback(
  o: IAdaptiveObject,
  callback: () => void,
): IDisposable {
  return setMultiCallback(o, true, () => {
    callback();
    return true;
  });
}

/**
 * Registers a callback that will fire ONCE when the next out-of-date
 * marking visits the object.
 */
export function onNextMarking(
  o: IAdaptiveObject,
  callback: () => void,
): IDisposable {
  return setMultiCallback(o, false, () => {
    try {
      callback();
      return false;
    } catch (e) {
      if (e instanceof LevelChangedException) return true;
      throw e;
    }
  });
}

/** Same as onNextMarking but holds the callback weakly. */
export function onWeakNextMarking(
  o: IAdaptiveObject,
  callback: () => void,
): IDisposable {
  return setMultiCallback(o, true, () => {
    try {
      callback();
      return false;
    } catch (e) {
      if (e instanceof LevelChangedException) return true;
      throw e;
    }
  });
}
