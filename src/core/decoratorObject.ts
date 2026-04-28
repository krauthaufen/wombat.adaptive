// Port of FSharp.Data.Adaptive Core/DecoratorObject.fs
//
// PORT NOTE: F# original was an `[<AbstractClass>]`. We mirror that as
// a TS class with no `abstract` markers; subclasses are expected to
// override `mark`/`inputChanged`/`allInputsProcessed` if they need
// non-default behaviour.
//
// PORT NOTE: F# `lock decorators (fun () -> ...)` calls are removed —
// JS single-threaded.
//
// PORT NOTE: F# original used a `Dictionary<WeakReference<...>, IndirectOutputObject>`
// keyed by the cached `WeakReference`. JS Map keys WeakRef objects by
// identity, so `Map<WeakRef<IAdaptiveObject>, IndirectOutputObject>`
// gives equivalent behaviour because each AdaptiveObject's `.weak`
// property returns the same WeakRef instance every time (it's lazily
// allocated and cached on the object).

import type { IAdaptiveObject, IWeakOutputSet } from "./types.js";
import { AdaptiveToken } from "./adaptiveToken.js";
import { IndirectOutputObject } from "./transaction.js";

export class DecoratorObject implements IAdaptiveObject {
  private readonly _input: IAdaptiveObject;
  // need to keep all decorators alive since they "live" in WeakOutputSets
  private readonly _decorators: Map<
    WeakRef<IAdaptiveObject>,
    IndirectOutputObject
  > = new Map();

  constructor(input: IAdaptiveObject) {
    this._input = input;
  }

  private removeDecorator = (d: IndirectOutputObject): void => {
    // F# original: `lock decorators (fun () -> ...)`. Removed.
    this._decorators.delete(d.real);
  };

  private getDecorator(
    caller: IAdaptiveObject,
    self: IAdaptiveObject,
  ): IndirectOutputObject {
    if (caller instanceof IndirectOutputObject) return caller;
    // F# original: `lock decorators (fun () -> ...)`. Removed.
    const existing = this._decorators.get(caller.weak);
    if (existing !== undefined) return existing;
    const o = IndirectOutputObject.create(caller, self, this.removeDecorator);
    this._decorators.set(caller.weak, o);
    return o;
  }

  // IAdaptiveObject delegates to input
  get tag(): unknown {
    return this._input.tag;
  }
  set tag(v: unknown) {
    this._input.tag = v;
  }
  get isConstant(): boolean {
    return this._input.isConstant;
  }
  get level(): number {
    return this._input.level;
  }
  set level(v: number) {
    this._input.level = v;
  }
  get outOfDate(): boolean {
    return this._input.outOfDate;
  }
  set outOfDate(v: boolean) {
    this._input.outOfDate = v;
  }
  get outputs(): IWeakOutputSet {
    return this._input.outputs;
  }
  get weak(): WeakRef<IAdaptiveObject> {
    return this._input.weak;
  }

  mark(): boolean {
    return this._input.mark();
  }
  inputChanged(t: unknown, o: IAdaptiveObject): void {
    this._input.inputChanged(t, o);
  }
  allInputsProcessed(t: unknown): void {
    this._input.allInputsProcessed(t);
  }

  evaluateAlways<T>(token: AdaptiveToken, action: (t: AdaptiveToken) => T): T {
    if (token.caller === null) {
      return action(token);
    } else {
      const c = this.getDecorator(token.caller, this);
      return action(token.withCaller(c));
    }
  }

  evaluateIfNeeded<T>(
    token: AdaptiveToken,
    whenUpToDate: T,
    action: (t: AdaptiveToken) => T,
  ): T {
    return this.evaluateAlways(token, (tok) => {
      if (this._input.outOfDate) return action(tok);
      return whenUpToDate;
    });
  }
}
