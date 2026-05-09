// Module-level pure helpers used by behavioural tests. Defined in a
// separate file so the plugin's closure-deps analysis classifies them
// as module bindings (no captured locals).
//
// Importantly, these are referenced by *identifier* in the tests
// (`av.map(double)`), which exercises the plugin's "bare-identifier
// callback → no body-hash, source identity is the function reference"
// path.

export function double(t: number): number {
  return t * 2;
}

export function isPositive(t: number): boolean {
  return t > 0;
}

export function negate(t: number): number {
  return -t;
}

export function pairKV(_k: string, v: number): number {
  return v * 10;
}
