// Port of FSharp.Data.Adaptive Datastructures/Operations.fs
//
// PORT NOTE: F# `[<Struct>]` becomes a TS class — JS has no struct
// distinction. F# discriminated union `ElementOperation` becomes a
// tagged-union type.

/**
 * Represents a set operation (Add/Remove) using a reference count.
 * Note that internally SetOperations may have reference counts > 1 and < -1.
 */
export class SetOperation<T> {
  /** The added/removed value */
  readonly value: T;
  /** The reference count delta. */
  readonly count: number;

  constructor(value: T, count: number) {
    this.value = value;
    this.count = count;
  }

  /** The inverse SetOperation to this one. */
  get inverse(): SetOperation<T> {
    return new SetOperation<T>(this.value, -this.count);
  }

  toString(): string {
    if (this.count === 1) return `Add(${String(this.value)})`;
    if (this.count === -1) return `Rem(${String(this.value)})`;
    if (this.count > 0) return `Add${this.count}(${String(this.value)})`;
    if (this.count < 0) return `Rem${-this.count}(${String(this.value)})`;
    return "Nop";
  }

  /** Creates an add operation (reference delta +1). */
  static add<T>(value: T): SetOperation<T> {
    return new SetOperation<T>(value, 1);
  }

  /** Creates a remove operation (reference delta -1). */
  static rem<T>(value: T): SetOperation<T> {
    return new SetOperation<T>(value, -1);
  }

  /** Creates a SetOperation with the given count. */
  static create<T>(count: number, value: T): SetOperation<T> {
    return new SetOperation<T>(value, count);
  }

  /** Applies a mapping function to the operation's value. */
  static map<A, B>(mapping: (a: A) => B, op: SetOperation<A>): SetOperation<B> {
    return new SetOperation<B>(mapping(op.value), op.count);
  }
}

/**
 * Represents an element operation (Set/Remove) without its key.
 * Typically datastructures will hold (key, ElementOperation) pairs.
 */
export type ElementOperation<T> =
  | { readonly tag: "Set"; readonly value: T }
  | { readonly tag: "Remove" };

export function ElementSet<T>(value: T): ElementOperation<T> {
  return { tag: "Set", value };
}

export const ElementRemove: ElementOperation<never> = { tag: "Remove" };

export function isSet<T>(
  op: ElementOperation<T>,
): op is { readonly tag: "Set"; readonly value: T } {
  return op.tag === "Set";
}

export function isRemove<T>(
  op: ElementOperation<T>,
): op is { readonly tag: "Remove" } {
  return op.tag === "Remove";
}
