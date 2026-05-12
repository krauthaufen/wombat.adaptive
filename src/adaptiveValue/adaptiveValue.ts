// Port of FSharp.Data.Adaptive AdaptiveValue/AdaptiveValue.fs +
// EvaluationCallbackExtensions.fs (the IAdaptiveValue<'T> entries).
//
// The public API is reshaped for TypeScript per the design decisions in
// `plan.md`:
//   * value-first / function-last argument order (flipped from F#);
//   * unary combinators exposed as both methods (`x.map(f)`) and free
//     functions (`AVal.map(x, f)`);
//   * n-ary combinators handled through a single `AVal.zip(...).map(f)`
//     / `AVal.zip(...).bind(f)` surface — variadic tuple types in TS
//     give full inference for any arity, so `map2`/`map3`/`bind2`/
//     `bind3` are not exposed at all;
//   * no F# legacy aliases retained.
//
// PORT NOTE: F# constant-folding logic (for arity 2/3) is generalised to
// arity N here — partial constants are forced once and the function is
// closed over them, with the remaining dynamic inputs dispatched to
// `MapVal`/`Map2Val`/`Map3Val`/`MapNVal` based on count.
//
// PORT NOTE: F#'s `IAdaptiveValueVisitor<'R>` exists to existentialise
// the generic argument of an `aval<'T>` at runtime — depends on .NET
// reified generics. TS erases generics, so visitors are structural and
// `accept` calls just forward `this`. `cast<T>` cannot recover the
// source type and instead structurally re-types via an identity
// mapping.
//
// PORT NOTE: F# `ContentType` returns `typeof<'T>`. There is no JS
// equivalent. Not exposed.
//
// PORT NOTE: F# `cheapEqual` (`ShallowEqualityComparer<'T>.Equals`) is
// identity for ref types and structural for value types. JS has no
// value types — cache short-circuit uses `Object.is`. Equivalent for
// primitives and reference types; structural-on-distinct-instances is
// not handled (matches F# `ShallowEqualityComparer` behaviour for non-
// struct records).
//
// PORT NOTE: F# `Interlocked.Exchange(&inputDirty, 0)` thread-safe
// read-and-clear becomes a plain read-then-clear (single-threaded JS).

import { AdaptiveObject, ConstantObject } from "../core/adaptiveObject.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import { DecoratorObject } from "../core/decoratorObject.js";
import {
  getRunningTransaction,
  markOutdated,
} from "../core/transaction.js";
import type { IDisposable } from "../core/callbacks.js";
import type { IAdaptiveObject } from "../core/types.js";
import { shallowHash } from "../datastructures/equality.js";

// ---------------------------------------------------------------------------
// IAdaptiveValue interfaces
// ---------------------------------------------------------------------------

export interface IAdaptiveValue extends IAdaptiveObject {
  getValueUntyped(token: AdaptiveToken): unknown;
  accept<R>(visitor: IAdaptiveValueVisitor<R>): R;
}

export interface IAdaptiveValue_<T> extends IAdaptiveValue {
  getValue(token: AdaptiveToken): T;
}

export interface IAdaptiveValueVisitor<R> {
  visit<T>(value: IAdaptiveValue_<T>): R;
}

/**
 * `aval<T>` — public alias used everywhere. Method-chained surface for
 * unary combinators is declared on this interface; classes implement
 * the methods directly.
 */
export interface aval<T> extends IAdaptiveValue_<T> {
  /**
   * Adaptively maps the value with `f`. Returns a new aval that
   * re-evaluates `f` whenever this value changes.
   */
  map<R>(f: (a: T) => R): aval<R>;

  /**
   * Adaptively binds the value with `f`. The returned aval depends on
   * whichever aval `f` produces for the current value.
   */
  bind<R>(f: (a: T) => aval<R>): aval<R>;

  /**
   * Maps the value with `f` *without* dirty tracking — the mapping is
   * re-applied every time the result is read. Use for cheap
   * projections (`unbox`, `fst`, etc.).
   */
  mapNonAdaptive<R>(f: (a: T) => R): aval<R>;

  /**
   * Reads the current value. Untracked. Should not be called inside
   * another adaptive evaluation.
   */
  force(): T;

  /**
   * Subscribes to value changes. Fires once immediately with the
   * current value, then on every subsequent change.
   */
  addCallback(action: (v: T) => void): IDisposable;

  /** Same as `addCallback` but keeps the callback weakly. */
  addWeakCallback(action: (v: T) => void): IDisposable;
}

// ---------------------------------------------------------------------------
// ChangeableValue<T> aka cval<T>
// ---------------------------------------------------------------------------

export class ChangeableValue<T>
  extends AdaptiveObject
  implements aval<T>
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

  getValue(token: AdaptiveToken): T {
    return this.evaluateAlways(token, () => this._value);
  }

  /**
   * Sets the current state of the cval. Returns whether the value
   * actually changed.
   */
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

  // aval<T> methods (delegate to free functions defined below)
  map<R>(f: (a: T) => R): aval<R> {
    return map(this, f);
  }
  bind<R>(f: (a: T) => aval<R>): aval<R> {
    return bind(this, f);
  }
  mapNonAdaptive<R>(f: (a: T) => R): aval<R> {
    return mapNonAdaptive(this, f);
  }
  force(): T {
    return force(this);
  }
  addCallback(action: (v: T) => void): IDisposable {
    return addCallback(this, action);
  }
  addWeakCallback(action: (v: T) => void): IDisposable {
    return addWeakCallback(this, action);
  }

  override toString(): string {
    return `cval(${String(this._value)})`;
  }
}

/** Type alias matching F# `cval<'T>`. */
export type cval<T> = ChangeableValue<T>;

/** Convenience constructor — `cval(0)` produces a `ChangeableValue<number>`. */
export function cval<T>(value: T): ChangeableValue<T> {
  return new ChangeableValue<T>(value);
}

// ---------------------------------------------------------------------------
// AbstractVal<T> — base for derived avals with caching
// ---------------------------------------------------------------------------

export abstract class AbstractVal<T>
  extends AdaptiveObject
  implements aval<T>
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
      return this._valueCache as T;
    });
  }

  accept<R>(visitor: IAdaptiveValueVisitor<R>): R {
    return visitor.visit(this);
  }
  getValueUntyped(token: AdaptiveToken): unknown {
    return this.getValue(token);
  }

  map<R>(f: (a: T) => R): aval<R> {
    return map(this, f);
  }
  bind<R>(f: (a: T) => aval<R>): aval<R> {
    return bind(this, f);
  }
  mapNonAdaptive<R>(f: (a: T) => R): aval<R> {
    return mapNonAdaptive(this, f);
  }
  force(): T {
    return force(this);
  }
  addCallback(action: (v: T) => void): IDisposable {
    return addCallback(this, action);
  }
  addWeakCallback(action: (v: T) => void): IDisposable {
    return addWeakCallback(this, action);
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
    return this.evaluateAlways(t, (tok) =>
      this.mapping(this.input.getValue(tok)),
    );
  }

  getValue(t: AdaptiveToken): B {
    return this.evaluateAlways(t, (tok) => this.mapping(this.input.getValue(tok)));
  }

  // aval<T> methods
  map<R>(f: (a: B) => R): aval<R> {
    return map(this, f);
  }
  bind<R>(f: (a: B) => aval<R>): aval<R> {
    return bind(this, f);
  }
  mapNonAdaptive<R>(f: (a: B) => R): aval<R> {
    return mapNonAdaptive(this, f);
  }
  force(): B {
    return force(this);
  }
  addCallback(action: (v: B) => void): IDisposable {
    return addCallback(this, action);
  }
  addWeakCallback(action: (v: B) => void): IDisposable {
    return addWeakCallback(this, action);
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

class ConstantVal<T> extends ConstantObject implements aval<T> {
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

  // aval<T> methods
  map<R>(f: (a: T) => R): aval<R> {
    return map(this, f);
  }
  bind<R>(f: (a: T) => aval<R>): aval<R> {
    return bind(this, f);
  }
  mapNonAdaptive<R>(f: (a: T) => R): aval<R> {
    return mapNonAdaptive(this, f);
  }
  force(): T {
    return force(this);
  }
  addCallback(_action: (v: T) => void): IDisposable {
    return addCallback(this, _action);
  }
  addWeakCallback(_action: (v: T) => void): IDisposable {
    return addWeakCallback(this, _action);
  }

  static lazy<T>(create: () => T): aval<T> {
    return new ConstantVal<T>(lazyOrValueFromCreate(create));
  }
  // PORT NOTE: F# named this `Value`. The TS name `valueOf` would
  // collide with `Object.prototype.valueOf` under `noImplicitOverride`.
  // Renamed to `of` to avoid the conflict.
  static of<T>(value: T): aval<T> {
    return new ConstantVal<T>(lazyOrValueFromValue(value));
  }

  override toString(): string {
    return `constval(${String(this.getCached())})`;
  }

  // PORT NOTE: F# overrode `Equals`/`GetHashCode` so two ConstantVals
  // with equal contained values are considered equal. JS `===` is
  // identity-only — exposed as `equals` / `getHashCode` instead.
  //
  // We compare/hash *shallowly* — by the contained value's IDENTITY
  // (`Object.is` for objects/functions; by value for primitives). So
  // two `AVal.constant(x)` collapse iff `x` is literally the same
  // primitive or the same object reference. That covers the realistic
  // dedup case (a shared `ITexture` / geometry buffer / sampler passed
  // through `AVal.constant(...)` at many call sites) without ever doing
  // a deep structural compare on the contained value — which, when one
  // distinct constant exists per scene leaf, would degrade a
  // `HashTable<aval<T>, …>` lookup (AtlasPool, …) into O(bucket) and
  // blow up boot/frame time. (Non-constant avals have no
  // `equals`/`getHashCode` → `defaultEquals`/`defaultHash` fall back to
  // reference identity for them too, which is correct — their value
  // can change, so only identity is stable.)
  //
  // The hash is memoised on first call: a `ConstantVal`'s contained
  // value is immutable, so the hash never changes. (`getCached()` is
  // lazy/idempotent, so hashing a never-forced constant just forces it
  // — safe by definition for constants.)
  private _hashCache: number | undefined = undefined;
  getHashCode(): number {
    if (this._hashCache === undefined) {
      this._hashCache = shallowHash(this.getCached()) | 0;
    }
    return this._hashCache;
  }
  equals(other: unknown): boolean {
    if (this === other) return true;
    if (other instanceof ConstantVal) {
      return Object.is(this.getCached(), other.getCached());
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Caster<A, B> — casts an aval<A> to aval<B>
// ---------------------------------------------------------------------------

function casterLambda<A, B>(): (a: A) => B {
  return (a) => a as unknown as B;
}

// ---------------------------------------------------------------------------
// MapVal<T1, T2>
// ---------------------------------------------------------------------------

class MapVal<T1, T2> extends AbstractVal<T2> {
  private readonly _mapping: (a: T1) => T2;
  private readonly _input: aval<T1>;
  private _cache: { input: T1; output: T2 } | undefined = undefined;

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
  private _cache: { a: T1; b: T2; out: T3 } | undefined = undefined;

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
// MapNVal — generic n-ary map for arity ≥ 4
// ---------------------------------------------------------------------------

class MapNVal<R> extends AbstractVal<R> {
  private readonly _inputs: aval<unknown>[];
  private readonly _mapping: (...vs: unknown[]) => R;
  private _cache: { inputs: unknown[]; output: R } | undefined = undefined;

  constructor(inputs: aval<unknown>[], mapping: (...vs: unknown[]) => R) {
    super();
    this._inputs = inputs;
    this._mapping = mapping;
  }

  override compute(token: AdaptiveToken): R {
    const current = this._inputs.map((v) => v.getValue(token));
    if (this._cache !== undefined && this._cache.inputs.length === current.length) {
      let allSame = true;
      for (let i = 0; i < current.length; i++) {
        if (!Object.is(this._cache.inputs[i], current[i])) {
          allSame = false;
          break;
        }
      }
      if (allSame) return this._cache.output;
    }
    const out = this._mapping(...current);
    this._cache = { inputs: current, output: out };
    return out;
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
// BindNVal — generic n-ary bind for arity ≥ 4
// ---------------------------------------------------------------------------

class BindNVal<R> extends AbstractVal<R> {
  private readonly _inputs: aval<unknown>[];
  private readonly _mapping: (...vs: unknown[]) => aval<R>;
  private _inner:
    | { inputs: unknown[]; result: aval<R> }
    | undefined = undefined;
  private _inputDirty = 1;

  constructor(
    inputs: aval<unknown>[],
    mapping: (...vs: unknown[]) => aval<R>,
  ) {
    super();
    this._inputs = inputs;
    this._mapping = mapping;
  }

  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    for (let i = 0; i < this._inputs.length; i++) {
      if (this._inputs[i] === o) {
        this._inputDirty = 1;
        return;
      }
    }
  }

  override compute(token: AdaptiveToken): R {
    const vals = this._inputs.map((v) => v.getValue(token));
    const wasDirty = this._inputDirty !== 0;
    this._inputDirty = 0;

    if (this._inner === undefined) {
      const result = this._mapping(...vals);
      this._inner = { inputs: vals, result };
      return result.getValue(token);
    }

    let allSame = true;
    for (let i = 0; i < vals.length; i++) {
      if (!Object.is(this._inner.inputs[i], vals[i])) {
        allSame = false;
        break;
      }
    }

    if (!wasDirty || allSame) {
      return this._inner.result.getValue(token);
    }

    this._inner.result.outputs.remove(this);
    const result = this._mapping(...vals);
    this._inner = { inputs: vals, result };
    return result.getValue(token);
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
// Internal n-ary dispatchers — generalise F# arity-2/3 partial-constant
// folding to arity N.
// ---------------------------------------------------------------------------

function partitionConstants(
  vals: ReadonlyArray<aval<unknown>>,
): {
  allConstant: boolean;
  constantValues: unknown[];
  dynamicVals: aval<unknown>[];
  dynamicIndices: number[];
} {
  const constantValues: unknown[] = new Array(vals.length).fill(undefined);
  const dynamicVals: aval<unknown>[] = [];
  const dynamicIndices: number[] = [];
  let allConstant = true;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]!;
    if (v.isConstant) {
      constantValues[i] = force(v);
    } else {
      allConstant = false;
      dynamicVals.push(v);
      dynamicIndices.push(i);
    }
  }
  return { allConstant, constantValues, dynamicVals, dynamicIndices };
}

function closeOverConstants<R>(
  arity: number,
  constantValues: unknown[],
  dynamicIndices: number[],
  f: (...vs: unknown[]) => R,
): (...vs: unknown[]) => R {
  if (dynamicIndices.length === arity) return f; // nothing to close over
  return (...dynVs: unknown[]) => {
    const args = constantValues.slice();
    for (let i = 0; i < dynamicIndices.length; i++) {
      args[dynamicIndices[i]!] = dynVs[i];
    }
    return f(...args);
  };
}

function mapInternal<R>(
  vals: ReadonlyArray<aval<unknown>>,
  f: (...vs: unknown[]) => R,
): aval<R> {
  if (vals.length === 0) return ConstantVal.lazy(() => f());

  const { allConstant, constantValues, dynamicVals, dynamicIndices } =
    partitionConstants(vals);

  if (allConstant) {
    return ConstantVal.lazy(() => f(...constantValues));
  }

  const wrapped = closeOverConstants(vals.length, constantValues, dynamicIndices, f);

  switch (dynamicVals.length) {
    case 1:
      return new MapVal<unknown, R>(
        (a) => wrapped(a),
        dynamicVals[0]!,
      );
    case 2:
      return new Map2Val<unknown, unknown, R>(
        (a, b) => wrapped(a, b),
        dynamicVals[0]!,
        dynamicVals[1]!,
      );
    case 3:
      return new Map3Val<unknown, unknown, unknown, R>(
        (a, b, c) => wrapped(a, b, c),
        dynamicVals[0]!,
        dynamicVals[1]!,
        dynamicVals[2]!,
      );
    default:
      return new MapNVal<R>(dynamicVals, wrapped);
  }
}

function bindInternal<R>(
  vals: ReadonlyArray<aval<unknown>>,
  f: (...vs: unknown[]) => aval<R>,
): aval<R> {
  if (vals.length === 0) return f();

  const { allConstant, constantValues, dynamicVals, dynamicIndices } =
    partitionConstants(vals);

  if (allConstant) {
    return f(...constantValues);
  }

  const wrapped = closeOverConstants(vals.length, constantValues, dynamicIndices, f);

  switch (dynamicVals.length) {
    case 1:
      return new BindVal<unknown, R>(
        (a) => wrapped(a),
        dynamicVals[0]!,
      );
    case 2:
      return new Bind2Val<unknown, unknown, R>(
        (a, b) => wrapped(a, b),
        dynamicVals[0]!,
        dynamicVals[1]!,
      );
    case 3:
      return new Bind3Val<unknown, unknown, unknown, R>(
        (a, b, c) => wrapped(a, b, c),
        dynamicVals[0]!,
        dynamicVals[1]!,
        dynamicVals[2]!,
      );
    default:
      return new BindNVal<R>(dynamicVals, wrapped);
  }
}

// ---------------------------------------------------------------------------
// Public unary combinators (free-function form)
// ---------------------------------------------------------------------------

export function force<T>(value: aval<T>): T {
  return value.getValue(AdaptiveToken.top);
}

export function init<T>(value: T): cval<T> {
  return new ChangeableValue<T>(value);
}

export function constant<T>(value: T): aval<T> {
  return ConstantVal.of(value);
}

export function delay<T>(create: () => T): aval<T> {
  return ConstantVal.lazy(create);
}

export function map<T, R>(value: aval<T>, f: (a: T) => R): aval<R> {
  return mapInternal([value], (v) => f(v as T));
}

export function bind<T, R>(
  value: aval<T>,
  f: (a: T) => aval<R>,
): aval<R> {
  return bindInternal([value], (v) => f(v as T));
}

export function mapNonAdaptive<T, R>(
  value: aval<T>,
  f: (a: T) => R,
): aval<R> {
  if (value.isConstant) {
    return ConstantVal.lazy(() => f(force(value)));
  }
  return new MapNonAdaptiveVal<T, R>(f, value);
}

export function cast<T>(value: IAdaptiveValue): aval<T> {
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

export function custom<T>(compute: (token: AdaptiveToken) => T): aval<T> {
  return new CustomVal<T>(compute);
}

// ---------------------------------------------------------------------------
// N-ary combinators — `zip` wrapper
// ---------------------------------------------------------------------------

/**
 * Maps a tuple of avals' element types out of the tuple shape.
 *   AValValues<[aval<A>, aval<B>]>  =  [A, B]
 */
type AValValues<T extends ReadonlyArray<aval<unknown>>> = {
  [K in keyof T]: T[K] extends aval<infer U> ? U : never;
};

/**
 * Wrapper produced by `zip(...vals)`. Carries the value-type tuple as
 * a phantom so `.map`/`.bind` callbacks are precisely typed.
 */
export class Zipped<Ts extends readonly unknown[]> {
  private readonly _avals: ReadonlyArray<aval<unknown>>;
  constructor(avals: ReadonlyArray<aval<unknown>>) {
    this._avals = avals;
  }

  /**
   * Adaptively maps the tuple of values with `f`. The callback's
   * argument types match the value-type tuple.
   */
  map<R>(f: (...vs: Ts) => R): aval<R> {
    return mapInternal(
      this._avals,
      f as unknown as (...vs: unknown[]) => R,
    );
  }

  /**
   * Adaptively binds the tuple of values with `f`. The callback returns
   * an `aval<R>` whose latest value the resulting aval reflects.
   */
  bind<R>(f: (...vs: Ts) => aval<R>): aval<R> {
    return bindInternal(
      this._avals,
      f as unknown as (...vs: unknown[]) => aval<R>,
    );
  }
}

/**
 * Combines any number of avals into a `Zipped` wrapper carrying their
 * value-type tuple. Used as the entry point for n-ary adaptive
 * combinators: `zip(x, y, z).map((a, b, c) => …)`.
 */
export function zip<T extends readonly aval<unknown>[]>(
  ...vals: T
): Zipped<AValValues<T>> {
  return new Zipped<AValValues<T>>(vals);
}

// ---------------------------------------------------------------------------
// EvaluationCallbackExtensions — IAdaptiveValue<'T> entries.
// (IOpReader entries belong to phase 4.)
// ---------------------------------------------------------------------------

function addCallbackInternal<T>(
  value: aval<T>,
  weak: boolean,
  action: (v: T) => void,
): IDisposable {
  let last: { v: T } | null = null;

  const onMark = () => {
    const t = getRunningTransaction();
    if (t === null) return;
    t.addFinalizer(() => {
      const v = force(value);
      if (last !== null && Object.is(last.v, v)) return;
      last = { v };
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
      last = { v };
      action(v);
    });
  } else {
    const v = force(value);
    last = { v };
    action(v);
  }

  return sub;
}

export function addCallback<T>(
  value: aval<T>,
  action: (v: T) => void,
): IDisposable {
  return addCallbackInternal(value, false, action);
}

export function addWeakCallback<T>(
  value: aval<T>,
  action: (v: T) => void,
): IDisposable {
  return addCallbackInternal(value, true, action);
}

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
// Public namespace surface
// ---------------------------------------------------------------------------

export const AVal = {
  force,
  init,
  constant,
  delay,
  custom,
  cast,
  map,
  bind,
  mapNonAdaptive,
  zip,
  addCallback,
  addWeakCallback,
};
