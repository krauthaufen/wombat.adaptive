// Vite plugin entry — opt-in compile-time rewrite of adaptive-combinator
// call sites to memoizing equivalents.
//
// Usage:
//
//   // vite.config.ts
//   import { adaptiveMemoPlugin } from "@aardworx/wombat.adaptive/plugin";
//   export default defineConfig({ plugins: [adaptiveMemoPlugin()] });
//
// The plugin transforms `someAval.map(fn)` (and friends) into
// `__memo([tag, hash, source, fn, ...closureDeps], () => someAval.map(fn))`,
// causing identity-defeating-sharing patterns to auto-collapse to a single
// derived adaptive value via the trie cache in `src/internal/memo.ts`.
//
// See `transform.ts` for the AST-level work.

import { transformAdaptiveMemo, type TransformResult } from "./transform.js";

export interface PluginOptions {
  /** File pattern to match. Defaults to `**\/*.{ts,tsx}` excluding node_modules. */
  readonly include?: RegExp;
  /** Optional override matcher (id-based). */
  readonly match?: (id: string) => boolean;
  /**
   * Module specifier emitted in the injected `import { __memo, ... }` line.
   * Defaults to `@aardworx/wombat.adaptive/internal`.
   */
  readonly internalModule?: string;
}

interface VitePlugin {
  name: string;
  enforce?: "pre" | "post";
  transform?(
    code: string,
    id: string,
  ): { code: string; map?: null } | null | undefined;
}

const DEFAULT_INCLUDE = /\.(ts|tsx)$/;

export function adaptiveMemoPlugin(options: PluginOptions = {}): VitePlugin {
  const matches =
    options.match ??
    ((id: string) => {
      if (/[\\/]node_modules[\\/]/.test(id)) return false;
      return (options.include ?? DEFAULT_INCLUDE).test(id);
    });
  const internalModule =
    options.internalModule ?? "@aardworx/wombat.adaptive/plugin/runtime";

  return {
    name: "wombat-adaptive-memo",
    enforce: "pre",
    transform(code: string, id: string) {
      const cleanId = id.split("?")[0]!;
      if (!matches(cleanId)) return null;
      const result = transformAdaptiveMemo(code, cleanId, { internalModule });
      if (!result) return null;
      return { code: result.code, map: null };
    },
  };
}

export { transformAdaptiveMemo, type TransformResult } from "./transform.js";
