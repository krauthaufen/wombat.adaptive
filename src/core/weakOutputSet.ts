// Port of FSharp.Data.Adaptive Core/Core.fs (the WeakOutputSet and
// EmptyOutputSet implementations).
//
// PORT NOTE: the F# source has two implementations gated by FABLE_COMPILER:
// the Fable variant uses strong references (no WeakRef in early Fable JS),
// the .NET variant uses WeakReference<IAdaptiveObject>. We port the .NET
// variant's *behavior* using JS native WeakRef, since memory hygiene in a
// long-running browser app is a real concern. The three-mode storage
// (single / array / set) is preserved structurally.
//
// PORT NOTE: the F# .NET variant uses `lock x (fun () -> ...)` around all
// public operations. JS is single-threaded so the lock calls are removed.
// Comments mark each location that originally held a lock.
//
// MEMORY NOTE (scene-templates M2): the whole state lives in ONE
// `_data` slot discriminated by runtime type —
//   null                → empty
//   IAdaptiveObject     → single output (the overwhelmingly common case),
//                         held STRONGLY: no WeakRef is allocated for it.
//                         A dead single output lives until the next
//                         consume (the input's next marking) or remove.
//   Array<WeakRef|null> → up to ArrayCapacity outputs
//   SetBox              → many outputs (Set + cleanup op counter)
// A scene with 200k adaptive nodes carries 200k of these objects, so
// the previous 5-field layout (~64 B each) was a top heap item; this
// layout is ~24 B for the empty/single states.

import {
  IAdaptiveObject,
  IWeakOutputSet,
  OutputBuffer,
  resizeOutputBuffer,
} from "./types.js";

const ArrayCapacity = 8;

/** Set-mode box: the Set plus the cleanup op counter (only needed in
 *  set mode — dead WeakRefs accumulate invisibly there, while the
 *  array mode reuses dead slots on add and compacts on remove). */
class SetBox {
  ops = 0;
  constructor(readonly set: Set<WeakRef<IAdaptiveObject>>) {}
}

type OutputData =
  | null
  | IAdaptiveObject
  | (WeakRef<IAdaptiveObject> | null)[]
  | SetBox;

/** The single-output state: a plain (strong) reference. */
function isSingle(d: OutputData): d is IAdaptiveObject {
  return d !== null && !Array.isArray(d) && !(d instanceof SetBox);
}

export class WeakOutputSet implements IWeakOutputSet {
  private _data: OutputData = null;

  private _add(obj: IAdaptiveObject): boolean {
    const data = this._data;
    if (data === null) {
      // The first output is held strongly: no WeakRef for the
      // overwhelmingly common single-output node.
      this._data = obj;
      return true;
    }
    if (isSingle(data)) {
      if (data === obj) return false;
      const arr: (WeakRef<IAdaptiveObject> | null)[] = new Array(
        ArrayCapacity,
      ).fill(null);
      arr[0] = data.weak;
      arr[1] = obj.weak;
      this._data = arr;
      return true;
    }
    const weakObj = obj.weak;
    if (Array.isArray(data)) {
      const arr = data;
      let freeIndex = -1;
      let i = 0;
      const len = arr.length;
      while (i < len) {
        const slot = arr[i];
        if (slot === null) {
          if (freeIndex < 0) freeIndex = i;
        } else if (slot === weakObj) {
          freeIndex = -2;
          i = len;
          break;
        } else {
          const v = slot.deref();
          if (v !== undefined) {
            if (v === obj) {
              freeIndex = -2;
              i = len;
              break;
            }
          } else {
            if (freeIndex < 0) freeIndex = i;
          }
        }
        i++;
      }

      if (freeIndex === -2) {
        return false;
      } else if (freeIndex >= 0) {
        arr[freeIndex] = weakObj;
        return true;
      } else {
        // r cannot be null here (empty index would have been found)
        const set = new Set<WeakRef<IAdaptiveObject>>();
        for (const r of arr) {
          if (r !== null && r.deref() !== undefined) set.add(r);
        }
        const sizeBefore = set.size;
        set.add(weakObj);
        const added = set.size > sizeBefore;
        this._data = new SetBox(set);
        return added;
      }
    }
    // set mode
    const set = data.set;
    const before = set.size;
    set.add(weakObj);
    return set.size > before;
  }

  /** Used internally to get rid of leaking WeakReferences. Drops the dead
   *  entries in place once the ops since the last sweep exceed the set's
   *  size (at least 100): amortised O(1) per op. (A sweep every 100 ops
   *  made filling a set with n outputs O(n²/100).) */
  private cleanup(): void {
    // F# original: `lock x (fun () -> ...)`. JS single-threaded, no lock.
    const data = this._data;
    if (data instanceof SetBox && data.ops > 100 && data.ops > data.set.size) {
      data.ops = 0;
      for (const r of data.set) if (r.deref() === undefined) data.set.delete(r);
    }
  }

  /**
   * Adds a weak reference to the given AdaptiveObject to the set.
   * Returns whether the obj was new.
   */
  add(obj: IAdaptiveObject): boolean {
    if (obj.isConstant) return false;
    // F# original: `lock x (fun () -> ...)`. Removed.
    if (this._add(obj)) {
      const data = this._data;
      if (data instanceof SetBox) {
        data.ops += 1;
        this.cleanup();
      }
      return true;
    } else {
      return false;
    }
  }

  /**
   * Removes the reference to the given AdaptiveObject from the set.
   * Returns whether the obj was removed.
   */
  remove(obj: IAdaptiveObject): boolean {
    if (obj.isConstant) return false;
    // F# original: `lock x (fun () -> ...)`. Removed.
    const data = this._data;
    if (data === null) return false;
    if (isSingle(data)) {
      if (data === obj) {
        this._data = null;
        return true;
      }
      return false;
    }
    if (Array.isArray(data)) {
      const arr = data;
      let found = false;
      let count = 0;
      let living: WeakRef<IAdaptiveObject> | null = null;
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (slot !== null) {
          const v = slot.deref();
          if (v !== undefined) {
            if (v === obj) {
              arr[i] = null;
              found = true;
            } else {
              count++;
              living = slot;
            }
          } else {
            arr[i] = null;
          }
        }
      }
      if (count === 0) {
        this._data = null;
      } else if (count === 1) {
        this._data = living!.deref() ?? null;
      }
      return found;
    }
    // set mode
    const set = data.set;
    if (set.delete(obj.weak)) {
      data.ops += 1;
      this.cleanup();
      return true;
    }
    return false;
  }

  /** Returns all currently living entries from the set and clears it. */
  consume(output: OutputBuffer): number {
    // F# original: `lock x (fun () -> ...)`. Removed.
    const data = this._data;
    let cnt = 0;
    if (data === null) {
      // nothing
    } else if (isSingle(data)) {
      if (output.value.length < 1) resizeOutputBuffer(output, 1);
      output.value[0] = data;
      cnt = 1;
    } else if (Array.isArray(data)) {
      let oi = 0;
      for (let i = 0; i < data.length; i++) {
        const r = data[i];
        if (r !== null) {
          const v = r.deref();
          if (v !== undefined) {
            if (oi >= output.value.length) {
              resizeOutputBuffer(output, oi << 2);
            }
            output.value[oi] = v;
            oi++;
          }
        }
      }
      cnt = oi;
    } else {
      let oi = 0;
      for (const r of data.set) {
        const v = r.deref();
        if (v !== undefined) {
          if (oi >= output.value.length) {
            resizeOutputBuffer(output, oi << 2);
          }
          output.value[oi] = v;
          oi++;
        }
      }
      cnt = oi;
    }
    this._data = null;
    return cnt;
  }

  clear(): void {
    // F# original: `lock x (fun () -> ...)`. Removed.
    this._data = null;
  }

  /**
   * Indicates whether the set is (conservatively) known to be empty.
   * Note that we don't dereference any WeakReferences here.
   */
  get isEmpty(): boolean {
    // F# original: `lock x (fun () -> ...)`. Removed.
    return this._data === null;
  }
}

/**
 * IWeakOutputSet implementation that always reports empty and rejects
 * modifications. Used by ConstantObject, where outputs are meaningless.
 */
export class EmptyOutputSet implements IWeakOutputSet {
  readonly isEmpty = true;
  add(_o: IAdaptiveObject): boolean {
    return false;
  }
  remove(_o: IAdaptiveObject): boolean {
    return false;
  }
  consume(_output: OutputBuffer): number {
    return 0;
  }
  clear(): void {
    /* no-op */
  }
}
