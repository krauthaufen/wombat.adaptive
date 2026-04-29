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

function hashObjectIdentity(o: object): number {
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

function hasCustomEquality(o: object): o is CustomEquatable {
  const eq = (o as { equals?: unknown }).equals;
  const gh = (o as { getHashCode?: unknown }).getHashCode;
  return typeof eq === "function" && typeof gh === "function";
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
      if (hasCustomEquality(o)) return o.getHashCode() | 0;
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
    typeof b === "object" &&
    hasCustomEquality(a as object) &&
    hasCustomEquality(b as object)
  ) {
    return (a as unknown as CustomEquatable).equals(b);
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
