// Port of FSharp.Data.Adaptive AdaptiveValue/AdaptiveValue.fs
//
// PORT NOTE: F#'s `IAdaptiveValueVisitor<'R>` exists to existentialise
// the generic argument of an `aval<'T>` at runtime — a feat that depends
// on .NET reified generics. TS erases generics, so the visitor here is
// purely structural and `Accept` calls just forward `this`. We keep the
// shape so `cast` can be ported faithfully, but the runtime
// effectiveness differs (callers cannot recover the original `T`).
//
// PORT NOTE: F# `ContentType` returns `typeof<'T>`. There is no JS
// runtime equivalent. We do not expose `contentType` in the TS port —
// every place in the F# original that consumed it depended on .NET
// reflection (FsCheck generators, etc.) and is out of scope here.
//
// PORT NOTE: F#'s `cheapEqual` is `ShallowEqualityComparer<'T>.Equals`
// which is identity for ref types and structural for value types. JS has
// no value types, so cache short-circuit here uses `Object.is`. This is
// equivalent for primitives and reference types — the divergence only
// shows up for structural equality across distinct object instances,
// which the F# `cheapEqual` would also typically miss for non-struct
// records.
//
// PORT NOTE: F# `Interlocked.Exchange(&inputDirty, 0)` is a thread-safe
// read-and-clear. JS single-threaded — replaced with plain
// read-then-clear.
//
// PORT NOTE: F# `OptimizedClosures.FSharpFunc<...>.Adapt` adapts curried
// functions into uncurried multi-arg form. TS functions accept multiple
// arguments natively; the wrapper is dropped.

import { AdaptiveObject, ConstantObject } from "../core/adaptiveObject.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import { DecoratorObject } from "../core/decoratorObject.js";
import {
  getRunningTransaction,
  markOutdated,
} from "../core/transaction.js";
import type { IDisposable } from "../core/callbacks.js";
import type { IAdaptiveObject } from "../core/types.js";

// ---------------------------------------------------------------------------
// IAdaptiveValue interfaces
// ---------------------------------------------------------------------------

export interface IAdaptiveValue extends IAdaptiveObject {
  /// Evaluates the AdaptiveValue using the given token and returns the
  /// current value as `unknown`. Dependencies will be tracked
  /// automatically when the token is correctly passed to all inner
  /// evaluation-calls.
  getValueUntyped(token: AdaptiveToken): unknown;

  /// Visits the IAdaptiveValue using the given visitor. PORT NOTE: see
  /// file header — runtime effectiveness limited compared to F#.
  accept<R>(visitor: IAdaptiveValueVisitor<R>): R;
}

export interface IAdaptiveValue_<T> extends IAdaptiveValue {
  /// Evaluates the AdaptiveValue<T> using the given token and returns
  /// the current value.
  getValue(token: AdaptiveToken): T;
}

export interface IAdaptiveValueVisitor<R> {
  visit<T>(value: IAdaptiveValue_<T>): R;
}

/// Type alias matching F# `aval<'T>`.
export type aval<T> = IAdaptiveValue_<T>;

// ---------------------------------------------------------------------------
// ChangeableValue<T> aka cval<T>
// ---------------------------------------------------------------------------

export class ChangeableValue<T>
  extends AdaptiveObject
  implements IAdaptiveValue_<T>
{
  private _value: T;

  constructor(value: T) {
    super();
    this._value = value;
  }

  get value(): T {
    return this._value;
  }
  set value(v: T) {
    if (!Object.is(this._value, v)) {
      this._value = v;
      markOutdated(this);
    }
  }

  getValue(_token: AdaptiveToken): T {
    return this.evaluateAlways(_token, () => this._value);
  }

  /// Sets the current state of the cval. Returns whether the value
  /// actually changed.
  updateTo(newValue: T): boolean {
    if (!Object.is(this._value, newValue)) {
      this._value = newValue;
      markOutdated(this);
      return true;
    }
    return false;
  }

  // IAdaptiveValue
  accept<R>(visitor: IAdaptiveValueVisitor<R>): R {
    return visitor.visit(this);
  }
  getValueUntyped(token: AdaptiveToken): unknown {
    return this.getValue(token);
  }

  override toString(): string {
    return `cval(${String(this._value)})`;
  }
}

/// Alias matching F# `cval<'T>`.
export type cval<T> = ChangeableValue<T>;

/// Convenience constructor matching the F# `cval value` syntax.
export function cval<T>(value: T): ChangeableValue<T> {
  return new ChangeableValue<T>(value);
}

// ---------------------------------------------------------------------------
// AbstractVal<T> — base for derived avals with caching
// ---------------------------------------------------------------------------

export abstract class AbstractVal<T>
  extends AdaptiveObject
  implements IAdaptiveValue_<T>
{
  private _valueCache: T | undefined = undefined;

  abstract compute(token: AdaptiveToken): T;

  getValue(token: AdaptiveToken): T {
    return this.evaluateAlways(token, (tok) => {
      if (this.outOfDate) {
        const v = this.compute(tok);
        this._valueCache = v;
        return v;
      }
      // Cast: when `outOfDate` is false, `_valueCache` has been set at
      // least once. (It's never read before the first compute.)
      return this._valueCache as T;
    });
  }

  accept<R>(visitor: IAdaptiveValueVisitor<R>): R {
    return visitor.visit(this);
  }
  getValueUntyped(token: AdaptiveToken): unknown {
    return this.getValue(token);
  }

  override toString(): string {
    if (this.outOfDate) return `aval*(${String(this._valueCache)})`;
    return `aval(${String(this._valueCache)})`;
  }
}

// ---------------------------------------------------------------------------
// MapNonAdaptiveVal — mapping without dirty tracking (always evaluated)
// ---------------------------------------------------------------------------

class MapNonAdaptiveVal<A, B> extends DecoratorObject implements aval<B> {
  readonly mapping: (a: A) => B;
  readonly input: aval<A>;

  constructor(mapping: (a: A) => B, input: aval<A>) {
    super(input);
    this.mapping = mapping;
    this.input = input;
  }

  accept<R>(visitor: IAdaptiveValueVisitor<R>): R {
    return visitor.visit(this);
  }

  getValueUntyped(t: AdaptiveToken): unknown {
    return this.evaluateAlways(t, (tok) => this.mapping(this.input.getValue(tok)));
  }

  getValue(t: AdaptiveToken): B {
    return this.evaluateAlways(t, (tok) => this.mapping(this.input.getValue(tok)));
  }

  override toString(): string {
    if (this.input.outOfDate) return "aval*";
    const v = this.input.getValue(AdaptiveToken.top);
    return `aval(${String(this.mapping(v))})`;
  }
}

// ---------------------------------------------------------------------------
// LazyOrValue + ConstantVal
// ---------------------------------------------------------------------------

interface LazyOrValue<T> {
  create: (() => T) | undefined;
  value: T | undefined;
  isValue: boolean;
}

function lazyOrValueFromValue<T>(value: T): LazyOrValue<T> {
  return { create: undefined, value, isValue: true };
}
function lazyOrValueFromCreate<T>(create: () => T): LazyOrValue<T> {
  return { create, value: undefined, isValue: false };
}

/// A constant value that can either be a value or a lazy computation.
class ConstantVal<T> extends ConstantObject implements IAdaptiveValue_<T> {
  private _data: LazyOrValue<T>;

  private constructor(data: LazyOrValue<T>) {
    super();
    this._data = data;
  }

  private getCached(): T {
    if (this._data.isValue) return this._data.value as T;
    const v = (this._data.create as () => T)();
    this._data = { create: undefined, value: v, isValue: true };
    return v;
  }

  getValue(_token: AdaptiveToken): T {
    return this.getCached();
  }

  accept<R>(visitor: IAdaptiveValueVisitor<R>): R {
    return visitor.visit(this);
  }
  getValueUntyped(token: AdaptiveToken): unknown {
    return this.getValue(token);
  }

  static lazy<T>(create: () => T): aval<T> {
    return new ConstantVal<T>(lazyOrValueFromCreate(create));
  }
  // PORT NOTE: F# named this `Value`. The TS name `valueOf` collides
  // with `Object.prototype.valueOf` (compiler complains about implicit
  // override). Renamed to `of` to avoid the conflict.
  static of<T>(value: T): aval<T> {
    return new ConstantVal<T>(lazyOrValueFromValue(value));
  }

  override toString(): string {
    return `constval(${String(this.getCached())})`;
  }

  // PORT NOTE: F# overrides `GetHashCode`/`Equals` so that two
  // ConstantVals with equal contained values are considered equal. JS
  // `===` is identity for objects; we cannot override `==` for arbitrary
  // objects. The `[AVal] constant equality` test in the F# suite relies
  // on this — we provide a public `equals` method as the documented way
  // to compare ConstantVals; the test is rewritten to use it.
  equals(other: unknown): boolean {
    if (other instanceof ConstantVal) {
      return Object.is(this.getCached(), other.getCached());
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Caster<A, B> — casts an aval<A> to aval<B>
// ---------------------------------------------------------------------------

// PORT NOTE: F# uses `typeof<'a>.IsAssignableFrom typeof<'b>` to check
// the cast at instantiation time. TS erases generics; we must trust the
// caller. The cast here is structural: just an identity-typed function.
// If the runtime value is incompatible with B, the failure surfaces
// later when `B`-typed operations run on it.
function casterLambda<A, B>(): (a: A) => B {
  return (a) => a as unknown as B;
}

// ---------------------------------------------------------------------------
// MapVal<T1, T2>
// ---------------------------------------------------------------------------

class MapVal<T1, T2> extends AbstractVal<T2> {
  private readonly _mapping: (a: T1) => T2;
  private readonly _input: aval<T1>;
  private _cache:
    | { input: T1; output: T2 }
    | undefined = undefined;

  constructor(mapping: (a: T1) => T2, input: aval<T1>) {
    super();
    this._mapping = mapping;
    this._input = input;
  }

  override compute(token: AdaptiveToken): T2 {
    const i = this._input.getValue(token);
    if (this._cache !== undefined && Object.is(this._cache.input, i)) {
      return this._cache.output;
    }
    const o = this._mapping(i);
    this._cache = { input: i, output: o };
    return o;
  }
}

// ---------------------------------------------------------------------------
// Map2Val<T1, T2, T3>
// ---------------------------------------------------------------------------

class Map2Val<T1, T2, T3> extends AbstractVal<T3> {
  private readonly _mapping: (a: T1, b: T2) => T3;
  private readonly _a: aval<T1>;
  private readonly _b: aval<T2>;
  private _cache:
    | { a: T1; b: T2; out: T3 }
    | undefined = undefined;

  constructor(mapping: (a: T1, b: T2) => T3, a: aval<T1>, b: aval<T2>) {
    super();
    this._mapping = mapping;
    this._a = a;
    this._b = b;
  }

  override compute(token: AdaptiveToken): T3 {
    const a = this._a.getValue(token);
    const b = this._b.getValue(token);
    if (
      this._cache !== undefined &&
      Object.is(this._cache.a, a) &&
      Object.is(this._cache.b, b)
    ) {
      return this._cache.out;
    }
    const c = this._mapping(a, b);
    this._cache = { a, b, out: c };
    return c;
  }
}

// ---------------------------------------------------------------------------
// Map3Val<T1, T2, T3, T4>
// ---------------------------------------------------------------------------

class Map3Val<T1, T2, T3, T4> extends AbstractVal<T4> {
  private readonly _mapping: (a: T1, b: T2, c: T3) => T4;
  private readonly _a: aval<T1>;
  private readonly _b: aval<T2>;
  private readonly _c: aval<T3>;
  private _cache:
    | { a: T1; b: T2; c: T3; out: T4 }
    | undefined = undefined;

  constructor(
    mapping: (a: T1, b: T2, c: T3) => T4,
    a: aval<T1>,
    b: aval<T2>,
    c: aval<T3>,
  ) {
    super();
    this._mapping = mapping;
    this._a = a;
    this._b = b;
    this._c = c;
  }

  override compute(token: AdaptiveToken): T4 {
    const a = this._a.getValue(token);
    const b = this._b.getValue(token);
    const c = this._c.getValue(token);
    if (
      this._cache !== undefined &&
      Object.is(this._cache.a, a) &&
      Object.is(this._cache.b, b) &&
      Object.is(this._cache.c, c)
    ) {
      return this._cache.out;
    }
    const d = this._mapping(a, b, c);
    this._cache = { a, b, c, out: d };
    return d;
  }
}

// ---------------------------------------------------------------------------
// BindVal<T1, T2>
// ---------------------------------------------------------------------------

class BindVal<T1, T2> extends AbstractVal<T2> {
  private readonly _mapping: (a: T1) => aval<T2>;
  private readonly _input: aval<T1>;
  private _inner: { a: T1; result: aval<T2> } | undefined = undefined;
  private _inputDirty = 1;

  constructor(mapping: (a: T1) => aval<T2>, input: aval<T1>) {
    super();
    this._mapping = mapping;
    this._input = input;
  }

  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    if (o === this._input) this._inputDirty = 1;
  }

  override compute(token: AdaptiveToken): T2 {
    const va = this._input.getValue(token);
    const wasDirty = this._inputDirty !== 0;
    this._inputDirty = 0;

    if (this._inner === undefined) {
      const result = this._mapping(va);
      this._inner = { a: va, result };
      return result.getValue(token);
    }

    if (!wasDirty || Object.is(this._inner.a, va)) {
      return this._inner.result.getValue(token);
    }

    this._inner.result.outputs.remove(this);
    const result = this._mapping(va);
    this._inner = { a: va, result };
    return result.getValue(token);
  }
}

// ---------------------------------------------------------------------------
// Bind2Val<T1, T2, T3>
// ---------------------------------------------------------------------------

class Bind2Val<T1, T2, T3> extends AbstractVal<T3> {
  private readonly _mapping: (a: T1, b: T2) => aval<T3>;
  private readonly _value1: aval<T1>;
  private readonly _value2: aval<T2>;
  private _inner: { a: T1; b: T2; result: aval<T3> } | undefined = undefined;
  private _inputDirty = 1;

  constructor(
    mapping: (a: T1, b: T2) => aval<T3>,
    value1: aval<T1>,
    value2: aval<T2>,
  ) {
    super();
    this._mapping = mapping;
    this._value1 = value1;
    this._value2 = value2;
  }

  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    if (o === this._value1 || o === this._value2) this._inputDirty = 1;
  }

  override compute(token: AdaptiveToken): T3 {
    const va = this._value1.getValue(token);
    const vb = this._value2.getValue(token);
    const wasDirty = this._inputDirty !== 0;
    this._inputDirty = 0;

    if (this._inner === undefined) {
      const res = this._mapping(va, vb);
      this._inner = { a: va, b: vb, result: res };
      return res.getValue(token);
    }

    if (
      !wasDirty ||
      (Object.is(this._inner.a, va) && Object.is(this._inner.b, vb))
    ) {
      return this._inner.result.getValue(token);
    }

    this._inner.result.outputs.remove(this);
    const res = this._mapping(va, vb);
    this._inner = { a: va, b: vb, result: res };
    return res.getValue(token);
  }
}

// ---------------------------------------------------------------------------
// Bind3Val<T1, T2, T3, T4>
// ---------------------------------------------------------------------------

class Bind3Val<T1, T2, T3, T4> extends AbstractVal<T4> {
  private readonly _mapping: (a: T1, b: T2, c: T3) => aval<T4>;
  private readonly _value1: aval<T1>;
  private readonly _value2: aval<T2>;
  private readonly _value3: aval<T3>;
  private _inner:
    | { a: T1; b: T2; c: T3; result: aval<T4> }
    | undefined = undefined;
  private _inputDirty = 1;

  constructor(
    mapping: (a: T1, b: T2, c: T3) => aval<T4>,
    value1: aval<T1>,
    value2: aval<T2>,
    value3: aval<T3>,
  ) {
    super();
    this._mapping = mapping;
    this._value1 = value1;
    this._value2 = value2;
    this._value3 = value3;
  }

  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    if (o === this._value1 || o === this._value2 || o === this._value3) {
      this._inputDirty = 1;
    }
  }

  override compute(token: AdaptiveToken): T4 {
    const va = this._value1.getValue(token);
    const vb = this._value2.getValue(token);
    const vc = this._value3.getValue(token);
    const wasDirty = this._inputDirty !== 0;
    this._inputDirty = 0;

    if (this._inner === undefined) {
      const res = this._mapping(va, vb, vc);
      this._inner = { a: va, b: vb, c: vc, result: res };
      return res.getValue(token);
    }

    if (
      !wasDirty ||
      (Object.is(this._inner.a, va) &&
        Object.is(this._inner.b, vb) &&
        Object.is(this._inner.c, vc))
    ) {
      return this._inner.result.getValue(token);
    }

    this._inner.result.outputs.remove(this);
    const res = this._mapping(va, vb, vc);
    this._inner = { a: va, b: vb, c: vc, result: res };
    return res.getValue(token);
  }
}

// ---------------------------------------------------------------------------
// CustomVal<T>
// ---------------------------------------------------------------------------

class CustomVal<T> extends AbstractVal<T> {
  private readonly _compute: (token: AdaptiveToken) => T;
  constructor(compute: (token: AdaptiveToken) => T) {
    super();
    this._compute = compute;
  }
  override compute(token: AdaptiveToken): T {
    return this._compute(token);
  }
}

// ---------------------------------------------------------------------------
// AVal module functions
// ---------------------------------------------------------------------------

/// Evaluates the given adaptive value and returns its current value.
/// Should not be used inside the adaptive evaluation of other
/// AdaptiveObjects since it does not track dependencies.
export function force<T>(value: aval<T>): T {
  return value.getValue(AdaptiveToken.top);
}

/// Creates a changeable adaptive value initially holding the given value.
export function init<T>(value: T): cval<T> {
  return new ChangeableValue<T>(value);
}

/// Creates a constant adaptive value always holding the given value.
export function constant<T>(value: T): aval<T> {
  return ConstantVal.of(value);
}

/// Creates a constant adaptive value using the given create function.
export function delay<T>(create: () => T): aval<T> {
  return ConstantVal.lazy(create);
}

/// Returns a new adaptive value that adaptively applies the mapping
/// function to the given adaptive input.
export function map<T1, T2>(
  mapping: (a: T1) => T2,
  value: aval<T1>,
): aval<T2> {
  if (value.isConstant) {
    return ConstantVal.lazy(() => mapping(force(value)));
  }
  return new MapVal<T1, T2>(mapping, value);
}

/// Returns a new adaptive value that applies the mapping function
/// whenever a value is demanded. Useful for very cheap mapping
/// functions. WARNING: the mapping is also called for unchanged inputs.
export function mapNonAdaptive<T1, T2>(
  mapping: (a: T1) => T2,
  value: aval<T1>,
): aval<T2> {
  if (value.isConstant) {
    return ConstantVal.lazy(() => mapping(force(value)));
  }
  return new MapNonAdaptiveVal<T1, T2>(mapping, value);
}

/// Casts the given adaptive value to the specified type. PORT NOTE:
/// see file header — this is a structural cast at runtime.
export function cast<T>(value: IAdaptiveValue): aval<T> {
  // F# version inspects via `Accept` to recover the source type
  // parameter. TS can't recover types, so we accept any aval and cast
  // through. If `value` is already an `aval<T>` (it usually is), the
  // returned value is identical.
  if (typeof (value as aval<T>).getValue === "function") {
    if ((value as IAdaptiveValue).isConstant) {
      return ConstantVal.lazy(() =>
        casterLambda<unknown, T>()(
          (value as IAdaptiveValue).getValueUntyped(AdaptiveToken.top),
        ),
      );
    }
    return new MapNonAdaptiveVal<unknown, T>(
      casterLambda<unknown, T>(),
      value as unknown as aval<unknown>,
    );
  }
  throw new Error("[adaptive-ts] cast target does not implement getValue");
}

export function map2<T1, T2, T3>(
  mapping: (a: T1, b: T2) => T3,
  value1: aval<T1>,
  value2: aval<T2>,
): aval<T3> {
  if (value1.isConstant && value2.isConstant) {
    return ConstantVal.lazy(() => mapping(force(value1), force(value2)));
  }
  if (value1.isConstant) {
    const a = force(value1);
    return map((b: T2) => mapping(a, b), value2);
  }
  if (value2.isConstant) {
    const b = force(value2);
    return map((a: T1) => mapping(a, b), value1);
  }
  return new Map2Val<T1, T2, T3>(mapping, value1, value2);
}

export function map3<T1, T2, T3, T4>(
  mapping: (a: T1, b: T2, c: T3) => T4,
  value1: aval<T1>,
  value2: aval<T2>,
  value3: aval<T3>,
): aval<T4> {
  if (value1.isConstant && value2.isConstant && value3.isConstant) {
    return ConstantVal.lazy(() =>
      mapping(force(value1), force(value2), force(value3)),
    );
  }
  if (value1.isConstant) {
    const a = force(value1);
    return map2((b: T2, c: T3) => mapping(a, b, c), value2, value3);
  }
  if (value2.isConstant) {
    const b = force(value2);
    return map2((a: T1, c: T3) => mapping(a, b, c), value1, value3);
  }
  if (value3.isConstant) {
    const c = force(value3);
    return map2((a: T1, b: T2) => mapping(a, b, c), value1, value2);
  }
  return new Map3Val<T1, T2, T3, T4>(mapping, value1, value2, value3);
}

export function bind<T1, T2>(
  mapping: (a: T1) => aval<T2>,
  value: aval<T1>,
): aval<T2> {
  if (value.isConstant) {
    return mapping(force(value));
  }
  return new BindVal<T1, T2>(mapping, value);
}

export function bind2<T1, T2, T3>(
  mapping: (a: T1, b: T2) => aval<T3>,
  value1: aval<T1>,
  value2: aval<T2>,
): aval<T3> {
  if (value1.isConstant && value2.isConstant) {
    return mapping(force(value1), force(value2));
  }
  if (value1.isConstant) {
    const a = force(value1);
    return bind((b: T2) => mapping(a, b), value2);
  }
  if (value2.isConstant) {
    const b = force(value2);
    return bind((a: T1) => mapping(a, b), value1);
  }
  return new Bind2Val<T1, T2, T3>(mapping, value1, value2);
}

export function bind3<T1, T2, T3, T4>(
  mapping: (a: T1, b: T2, c: T3) => aval<T4>,
  value1: aval<T1>,
  value2: aval<T2>,
  value3: aval<T3>,
): aval<T4> {
  if (value1.isConstant && value2.isConstant && value3.isConstant) {
    return mapping(force(value1), force(value2), force(value3));
  }
  if (value1.isConstant) {
    const a = force(value1);
    return bind2((b: T2, c: T3) => mapping(a, b, c), value2, value3);
  }
  if (value2.isConstant) {
    const b = force(value2);
    return bind2((a: T1, c: T3) => mapping(a, b, c), value1, value3);
  }
  if (value3.isConstant) {
    const c = force(value3);
    return bind2((a: T1, b: T2) => mapping(a, b, c), value1, value2);
  }
  return new Bind3Val<T1, T2, T3, T4>(mapping, value1, value2, value3);
}

/// Creates a custom adaptive value using the given computation. Callers
/// are responsible for removing inputs that are no longer needed.
export function custom<T>(compute: (token: AdaptiveToken) => T): aval<T> {
  return new CustomVal<T>(compute);
}

/// Convenience namespace mirroring the F# `AVal` module surface.
export const AVal = {
  force,
  init,
  constant,
  delay,
  map,
  mapNonAdaptive,
  cast,
  map2,
  map3,
  bind,
  bind2,
  bind3,
  custom,
};

// ---------------------------------------------------------------------------
// Equality helper for ConstantVal (see PORT NOTE above)
// ---------------------------------------------------------------------------

export function constantEquals<T>(a: aval<T>, b: aval<T>): boolean {
  if (a instanceof ConstantVal && b instanceof ConstantVal) {
    return a.equals(b);
  }
  return a === b;
}

// ---------------------------------------------------------------------------
// EvaluationCallbackExtensions — port of EvaluationCallbackExtensions.fs
// (the IAdaptiveValue<'T> entries; IOpReader entries belong to phase 4).
// ---------------------------------------------------------------------------

// PORT NOTE: F# adds these via interface extension members. TS has no
// extension methods — exposed as free functions taking `aval<T>` plus a
// thin instance-method delegate added to AbstractVal and
// ChangeableValue for ergonomic parity with the F# `value.AddCallback`
// call sites. ConstantVal is intentionally excluded (its value never
// changes).

function addCallbackInternal<T>(
  value: aval<T>,
  weak: boolean,
  action: (v: T) => void,
): IDisposable {
  const last: { v: T } | null[] = [null] as unknown as { v: T } | null[];
  let lastBox: { v: T } | null = null;

  const onMark = () => {
    const t = getRunningTransaction();
    if (t === null) return;
    t.addFinalizer(() => {
      const v = force(value);
      if (lastBox !== null && Object.is(lastBox.v, v)) return;
      lastBox = { v };
      action(v);
    });
  };

  const sub = weak
    ? (value as unknown as AdaptiveObject).addWeakMarkingCallback(onMark)
    : (value as unknown as AdaptiveObject).addMarkingCallback(onMark);

  // initial fire
  const t0 = getRunningTransaction();
  if (t0 !== null) {
    t0.addFinalizer(() => {
      const v = force(value);
      lastBox = { v };
      action(v);
    });
  } else {
    const v = force(value);
    lastBox = { v };
    action(v);
  }

  return sub;
}

/// Adds a disposable callback to the aval that will be executed
/// whenever the aval's value changed. Fires once immediately with the
/// current value (or via the running transaction's finalizers if
/// invoked inside a transaction).
export function addCallback<T>(
  value: aval<T>,
  action: (v: T) => void,
): IDisposable {
  return addCallbackInternal(value, false, action);
}

/// Same as `addCallback` but holds the callback weakly.
export function addWeakCallback<T>(
  value: aval<T>,
  action: (v: T) => void,
): IDisposable {
  return addCallbackInternal(value, true, action);
}

// Instance-method delegates for ChangeableValue and AbstractVal so call
// sites can write `value.addCallback(action)` matching the F# style.
declare module "./adaptiveValue.js" {
  interface ChangeableValue<T> {
    addCallback(action: (v: T) => void): IDisposable;
    addWeakCallback(action: (v: T) => void): IDisposable;
  }
  interface AbstractVal<T> {
    addCallback(action: (v: T) => void): IDisposable;
    addWeakCallback(action: (v: T) => void): IDisposable;
  }
}

ChangeableValue.prototype.addCallback = function <T>(
  this: ChangeableValue<T>,
  action: (v: T) => void,
): IDisposable {
  return addCallback(this, action);
};
ChangeableValue.prototype.addWeakCallback = function <T>(
  this: ChangeableValue<T>,
  action: (v: T) => void,
): IDisposable {
  return addWeakCallback(this, action);
};
AbstractVal.prototype.addCallback = function <T>(
  this: AbstractVal<T>,
  action: (v: T) => void,
): IDisposable {
  return addCallback(this, action);
};
AbstractVal.prototype.addWeakCallback = function <T>(
  this: AbstractVal<T>,
  action: (v: T) => void,
): IDisposable {
  return addWeakCallback(this, action);
};
