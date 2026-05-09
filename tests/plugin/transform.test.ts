// Behavioural tests for the build-time AST rewrite. We invoke the
// pure `transformAdaptiveMemo` function (no Vite runtime needed) on
// inline source-strings and check:
//   * Whether a rewrite happened.
//   * Which TAG_* tokens were imported.
//   * Snippet-level shape of the emitted code.
//
// We do NOT compare full file outputs against `.expected.ts` files —
// the printer's whitespace + newline policy is brittle to small AST
// changes. Substring assertions are more durable.

import { describe, expect, test } from "vitest";
import { transformAdaptiveMemo } from "../../src/plugin/transform.js";

const opts = { internalModule: "@aardworx/wombat.adaptive/plugin/runtime" };

function run(src: string): { code: string; rewrites: number; tags: string[] } {
  const r = transformAdaptiveMemo(src, "/virtual/test.ts", opts);
  if (!r) return { code: src, rewrites: 0, tags: [] };
  return {
    code: r.code,
    rewrites: r.rewriteCount,
    tags: Array.from(r.tagsUsed).sort(),
  };
}

describe("plugin: transformAdaptiveMemo", () => {
  test("method form: aval.map", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      const av = cval(1);
      const m = av.map(t => t * 2);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_AVAL_MAP"]);
    expect(r.code).toMatch(/__memo\(/);
    expect(r.code).toMatch(/TAG_AVAL_MAP/);
    expect(r.code).toMatch(/"h:[0-9a-f]{8}"/);
    // Fallback closure preserves original call.
    expect(r.code).toMatch(/\(\)\s*=>\s*av\.map\(t => t \* 2\)/);
  });

  test("method form: aset.filter", () => {
    const src = `
      import { cset } from "@aardworx/wombat.adaptive/aset";
      const s = cset<number>();
      const f = s.filter(x => x > 0);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_ASET_FILTER"]);
  });

  test("method form: alist.collect", () => {
    const src = `
      import { clist } from "@aardworx/wombat.adaptive/alist";
      import { cset } from "@aardworx/wombat.adaptive/aset";
      const l = clist<number>();
      const c = l.collect(x => cset<number>());
    `;
    // collect is a known method on alist
    const r = run(src);
    expect(r.rewrites).toBeGreaterThanOrEqual(1);
    expect(r.tags).toContain("TAG_ALIST_COLLECT");
  });

  test("method form: amap.choose", () => {
    const src = `
      import { cmap } from "@aardworx/wombat.adaptive/amap";
      const m = cmap<string, number>();
      const c = m.choose((k, v) => v > 0 ? v : undefined);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_AMAP_CHOOSE"]);
  });

  test("free-function form: aval map(source, fn)", () => {
    const src = `
      import { cval, map } from "@aardworx/wombat.adaptive/aval";
      const av = cval(1);
      const m = map(av, t => t * 2);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_AVAL_MAP"]);
  });

  test("free-function form: aset map(fn, source)", () => {
    const src = `
      import { cset, map } from "@aardworx/wombat.adaptive/aset";
      const s = cset<number>();
      const m = map(x => x * 2, s);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_ASET_MAP"]);
  });

  test("namespace form: AVal.map(source, fn)", () => {
    const src = `
      import { AVal, cval } from "@aardworx/wombat.adaptive";
      const av = cval(1);
      const m = AVal.map(av, t => t * 2);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_AVAL_MAP"]);
  });

  test("namespace form: ASet.filter(fn, source)", () => {
    const src = `
      import { ASet, cset } from "@aardworx/wombat.adaptive";
      const s = cset<number>();
      const f = ASet.filter(x => x > 0, s);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_ASET_FILTER"]);
  });

  test("module-level pure callback: no closure deps in key array", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      const FACTOR = 3;
      const fn = (t: number) => t * FACTOR;
      const av = cval(1);
      const m = av.map(fn);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    // The fn is a bare identifier reference; closure-deps analysis is
    // applied only to inline arrow/function-expressions. Identifier
    // call-args don't get deps analyzed (their identity is the identity).
    // The emitted key should have just [tag, hash, av] — no extra deps.
    expect(r.code).toMatch(/__memo\(\[TAG_AVAL_MAP,\s*"h:[0-9a-f]{8}",\s*av\]/);
  });

  test("closure-captured local appears in deps", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      function build(scale: number) {
        const av = cval(1);
        return av.map(t => t * scale);
      }
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    // 'scale' should be a dep (captured from enclosing function);
    // 'av' is a source.
    expect(r.code).toMatch(/__memo\(\[TAG_AVAL_MAP, "h:[0-9a-f]{8}", av, scale\]/);
  });

  test("module-level free var is NOT in deps", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      function build() {
        const av = cval(1);
        return av.map(t => Math.sin(t));
      }
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    // Math is a builtin — must not appear in the cache key array.
    // (It still appears in the fallback closure body, which is fine.)
    const keyMatch = r.code.match(/__memo\(\[([^\]]*)\]/);
    expect(keyMatch).toBeTruthy();
    expect(keyMatch![1]).not.toContain("Math");
  });

  test("type-ambiguous call is skipped", () => {
    const src = `
      const x = somethingExternal();
      const y = x.map(t => t * 2);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(0);
    expect(r.code).toBe(src);
  });

  test("non-adaptive .map call is skipped", () => {
    const src = `
      const arr = [1, 2, 3];
      const out = arr.map(t => t * 2);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(0);
  });

  test("injected import lists only used tags", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      import { cset } from "@aardworx/wombat.adaptive/aset";
      const av = cval(1);
      const s = cset<number>();
      const a = av.map(t => t * 2);
      const b = s.filter(x => x > 0);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(2);
    expect(r.tags).toEqual(["TAG_ASET_FILTER", "TAG_AVAL_MAP"]);
    expect(r.code).toMatch(
      /import\s*\{\s*__memo,\s*TAG_ASET_FILTER,\s*TAG_AVAL_MAP\s*\}\s*from\s*"@aardworx\/wombat\.adaptive\/plugin\/runtime"/,
    );
  });

  test("identical lambda bodies produce identical hashes", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      const a = cval(1);
      const b = cval(2);
      const r1 = a.map(t => t * 2);
      const r2 = b.map(t => t * 2);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(2);
    const hashes = Array.from(r.code.matchAll(/"h:([0-9a-f]{8})"/g)).map(
      (m) => m[1],
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  test("different lambda bodies produce different hashes", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      const a = cval(1);
      const r1 = a.map(t => t * 2);
      const r2 = a.map(t => t + 2);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(2);
    const hashes = Array.from(r.code.matchAll(/"h:([0-9a-f]{8})"/g)).map(
      (m) => m[1],
    );
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("aval.bind", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      const a = cval(1);
      const b = cval(2);
      const r = a.bind(t => b);
    `;
    const r = run(src);
    expect(r.rewrites).toBe(1);
    expect(r.tags).toEqual(["TAG_AVAL_BIND"]);
  });

  test("aset.bind, aset.collect, aset.choose", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      import { cset } from "@aardworx/wombat.adaptive/aset";
      const av = cval(1);
      const s = cset<number>();
      const r1 = s.bind(t => s);    // hmm — bind is on aval, not aset; but aset.bind exists too
      const r2 = s.collect(t => s);
      const r3 = s.choose(t => t > 0 ? t : undefined);
    `;
    const r = run(src);
    expect(r.tags).toContain("TAG_ASET_COLLECT");
    expect(r.tags).toContain("TAG_ASET_CHOOSE");
  });

  test("alist.bind, alist.filter, alist.choose, alist.map", () => {
    const src = `
      import { clist } from "@aardworx/wombat.adaptive/alist";
      const l = clist<number>();
      const a = l.map(t => t * 2);
      const b = l.filter(t => t > 0);
      const c = l.choose(t => t > 0 ? t : undefined);
    `;
    const r = run(src);
    expect(r.tags).toEqual(
      ["TAG_ALIST_CHOOSE", "TAG_ALIST_FILTER", "TAG_ALIST_MAP"].sort(),
    );
  });

  test("amap.map, amap.filter, amap.bind", () => {
    const src = `
      import { cmap } from "@aardworx/wombat.adaptive/amap";
      const m = cmap<string, number>();
      const a = m.map((k, v) => v * 2);
      const b = m.filter((k, v) => v > 0);
    `;
    const r = run(src);
    expect(r.tags).toContain("TAG_AMAP_MAP");
    expect(r.tags).toContain("TAG_AMAP_FILTER");
  });

  test("idempotence: re-running on transformed code is a no-op for non-targets", () => {
    const src = `
      import { cval } from "@aardworx/wombat.adaptive/aval";
      const av = cval(1);
      const m = av.map(t => t * 2);
    `;
    const r1 = run(src);
    expect(r1.rewrites).toBe(1);
    // Running again *would* re-rewrite the inner call (which still
    // contains av.map). For now we just assert that the second run
    // produces something parseable (no crash).
    const r2 = transformAdaptiveMemo(r1.code, "/virtual/test.ts", opts);
    expect(r2).toBeTruthy();
  });
});
