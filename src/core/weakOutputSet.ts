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

import {
  IAdaptiveObject,
  IWeakOutputSet,
  OutputBuffer,
  resizeOutputBuffer,
} from "./types.js";

const ArrayCapacity = 8;

// PORT NOTE: F# used `[<Struct; StructLayout(LayoutKind.Explicit)>]
// VolatileSetData` with field-offset 0 for all variants — a tagged union
// implemented as an unsafe overlay. We replace this with a discriminated
// union represented by the `tag` field and a single `data` slot whose
// runtime type matches the tag. Behaviour is identical.
const TAG_SINGLE_OR_ARRAY = 0;
const TAG_ARRAY = 1;
const TAG_SET = 2;

export class WeakOutputSet implements IWeakOutputSet {
  // tag = 0: single (data is WeakRef | null) or empty (data is null)
  // tag = 1: array of (WeakRef | null), capacity ArrayCapacity
  // tag = 2: Set of WeakRef
  private _tag = TAG_SINGLE_OR_ARRAY;
  private _single: WeakRef<IAdaptiveObject> | null = null;
  private _array: (WeakRef<IAdaptiveObject> | null)[] | null = null;
  private _set: Set<WeakRef<IAdaptiveObject>> | null = null;
  private _setOps = 0;

  private _add(obj: IAdaptiveObject): boolean {
    const weakObj = obj.weak;
    switch (this._tag) {
      case TAG_SINGLE_OR_ARRAY: {
        if (this._single === null) {
          this._single = weakObj;
          return true;
        } else if (this._single === weakObj) {
          return false;
        } else {
          const existing = this._single.deref();
          if (existing !== undefined) {
            if (existing === obj) {
              return false;
            } else {
              const arr: (WeakRef<IAdaptiveObject> | null)[] = new Array(
                ArrayCapacity,
              ).fill(null);
              arr[0] = this._single;
              arr[1] = weakObj;
              this._tag = TAG_ARRAY;
              this._array = arr;
              this._single = null;
              return true;
            }
          } else {
            // Existing single is dead — replace it.
            this._single = weakObj;
            return true;
          }
        }
      }
      case TAG_ARRAY: {
        const arr = this._array!;
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
          this._tag = TAG_SET;
          this._set = set;
          this._array = null;
          return added;
        }
      }
      default: {
        const set = this._set!;
        const before = set.size;
        set.add(weakObj);
        return set.size > before;
      }
    }
  }

  /** Used internally to get rid of leaking WeakReferences. */
  private cleanup(): void {
    // F# original: `lock x (fun () -> ...)`. JS single-threaded, no lock.
    if (this._setOps > 100) {
      this._setOps = 0;
      const buf: OutputBuffer = { value: new Array(100).fill(undefined) };
      const cnt = this.consume(buf);
      for (let i = 0; i < cnt; i++) {
        const o = buf.value[i];
        if (o !== undefined) this._add(o);
      }
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
      this._setOps += 1;
      this.cleanup();
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
    switch (this._tag) {
      case TAG_SINGLE_OR_ARRAY: {
        if (this._single === null) return false;
        const v = this._single.deref();
        if (v !== undefined) {
          if (v === obj) {
            this._single = null;
            return true;
          } else {
            return false;
          }
        } else {
          this._single = null;
          return false;
        }
      }
      case TAG_ARRAY: {
        const arr = this._array!;
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
          this._tag = TAG_SINGLE_OR_ARRAY;
          this._single = null;
          this._array = null;
        } else if (count === 1) {
          this._tag = TAG_SINGLE_OR_ARRAY;
          this._single = living;
          this._array = null;
        }
        return found;
      }
      default: {
        const set = this._set!;
        if (set.delete(obj.weak)) {
          this._setOps += 1;
          this.cleanup();
          return true;
        } else {
          return false;
        }
      }
    }
  }

  /** Returns all currently living entries from the set and clears it. */
  consume(output: OutputBuffer): number {
    // F# original: `lock x (fun () -> ...)`. Removed.
    let cnt = 0;
    switch (this._tag) {
      case TAG_SINGLE_OR_ARRAY: {
        if (this._single !== null) {
          const v = this._single.deref();
          if (v !== undefined) {
            if (output.value.length < 1) resizeOutputBuffer(output, 1);
            output.value[0] = v;
            cnt = 1;
          } else {
            cnt = 0;
          }
        }
        break;
      }
      case TAG_ARRAY: {
        const arr = this._array!;
        let oi = 0;
        for (let i = 0; i < arr.length; i++) {
          const r = arr[i];
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
        break;
      }
      default: {
        const set = this._set!;
        let oi = 0;
        for (const r of set) {
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
        break;
      }
    }
    this._tag = TAG_SINGLE_OR_ARRAY;
    this._single = null;
    this._array = null;
    this._set = null;
    this._setOps = 0;
    return cnt;
  }

  clear(): void {
    // F# original: `lock x (fun () -> ...)`. Removed.
    this._tag = TAG_SINGLE_OR_ARRAY;
    this._single = null;
    this._array = null;
    this._set = null;
    this._setOps = 0;
  }

  /**
   * Indicates whether the set is (conservatively) known to be empty.
   * Note that we don't dereference any WeakReferences here.
   */
  get isEmpty(): boolean {
    // F# original: `lock x (fun () -> ...)`. Removed.
    if (this._tag === TAG_SINGLE_OR_ARRAY) {
      return this._single === null;
    }
    return false;
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
