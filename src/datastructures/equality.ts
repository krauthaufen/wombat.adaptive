// Equality + hashing utilities for adaptive-ts datastructures.
//
// PORT NOTE: F# datastructures take an `IEqualityComparer<'K>`. .NET
// supplies a default one via `EqualityComparer<'K>.Default` which uses
// `GetHashCode`/`Equals` from the runtime. JS has no equivalent — we
// provide a default hasher and equality function below.
//
// PORT NOTE: hashing semantics for the HAMT need 32-bit integer hashes.
// We hash:
//   * `number` — using a stable bit-mixing function (handles both ints
//     and floats deterministically);
//   * `string` — FNV-1a 32-bit;
//   * `boolean` — 0 / 1;
//   * `null` / `undefined` — 0;
//   * `bigint` — by stringification then FNV-1a;
//   * objects with both `equals(other): boolean` and
//     `getHashCode(): number` methods — those user-supplied methods
//     are used (matches F#'s Equals/GetHashCode contract);
//   * other objects — identity hash via a WeakMap that assigns a
//     unique 32-bit integer per object on first observation, plus
//     `Object.is` equality.

export interface IEqualityComparer<K> {
  equals(a: K, b: K): boolean;
  hash(k: K): number;
}

const fnv1aPrime = 0x01000193;
const fnv1aOffset = 0x811c9dc5;

function hashString(s: string): number {
  let h = fnv1aOffset;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, fnv1aPrime);
  }
  return h | 0;
}

function hashNumber(n: number): number {
  if (n === 0) return 0;
  if (Number.isInteger(n) && n === (n | 0)) return n | 0;
  // Bit-pattern hash for non-int / non-32-bit numbers.
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = n;
  const ints = new Uint32Array(buf);
  return ((ints[0]! ^ ints[1]!) | 0);
}

let _identityCounter = 0;
const _identityHashes = new WeakMap<object, number>();

export function hashObjectIdentity(o: object): number {
  let id = _identityHashes.get(o);
  if (id === undefined) {
    _identityCounter = (_identityCounter + 1) | 0;
    id = _identityCounter;
    _identityHashes.set(o, id);
  }
  return id;
}

interface CustomEquatable {
  equals(other: unknown): boolean;
  getHashCode(): number;
}

// Accepts the camelCase convention used by wombat.* TS types AND the
// PascalCase Equals/GetHashCode that Fable emits for F# types with
// structural equality. Returns a {equals, getHashCode} view in either
// case so the rest of the file can stay convention-agnostic.
function customEquality(o: object): CustomEquatable | null {
  const r = o as Record<string, unknown>;
  const eq = r.equals ?? r.Equals;
  const gh = r.getHashCode ?? r.GetHashCode;
  if (typeof eq === "function" && typeof gh === "function") {
    return {
      equals: (other) => (eq as (this: object, x: unknown) => boolean).call(o, other),
      getHashCode: () => (gh as (this: object) => number).call(o),
    };
  }
  return null;
}

export function defaultHash(k: unknown): number {
  if (k === null || k === undefined) return 0;
  switch (typeof k) {
    case "number":
      return hashNumber(k);
    case "string":
      return hashString(k);
    case "boolean":
      return k ? 1 : 0;
    case "bigint":
      return hashString(k.toString());
    case "symbol":
      return hashString(k.toString());
    default: {
      const o = k as object;
      const ce = customEquality(o);
      if (ce !== null) return ce.getHashCode() | 0;
      return hashObjectIdentity(o);
    }
  }
}

export function defaultEquals<K>(a: K, b: K): boolean {
  if (Object.is(a, b)) return true;
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object"
  ) {
    const ca = customEquality(a as object);
    const cb = customEquality(b as object);
    if (ca !== null && cb !== null) return ca.equals(b);
  }
  return false;
}

export const defaultComparer: IEqualityComparer<unknown> = {
  equals: defaultEquals,
  hash: defaultHash,
};

export function comparerFor<K>(): IEqualityComparer<K> {
  return defaultComparer as IEqualityComparer<K>;
}

/**
 * Shallow (1-level) hash for `ConstantVal.getHashCode()`: a primitive
 * hashes by value; an object/function hashes by *identity*. Pairs with
 * `Object.is` shallow equality — so two `AVal.constant(x)` collapse iff
 * `x` is the same primitive or the same object reference (the realistic
 * dedup case — shared textures / geometry buffers / etc.) — without ever
 * doing a deep structural compare (which, at scale with one constant
 * per scene leaf, would turn a `HashTable` lookup into O(bucket)).
 */
export function shallowHash(k: unknown): number {
  if (k === null || k === undefined) return 0;
  switch (typeof k) {
    case "number":  return hashNumber(k);
    case "string":  return hashString(k);
    case "boolean": return k ? 1 : 0;
    case "bigint":  return hashString(k.toString());
    case "symbol":  return hashString(k.toString());
    default:        return hashObjectIdentity(k as object);
  }
}
