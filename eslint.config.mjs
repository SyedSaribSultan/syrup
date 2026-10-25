import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The esbuild bundle of the sandbox sidecar (sidecar/build.mjs), generated and git-ignored like .next.
    ".sidecar/**",
    // The vendored Sarib design system (sarib-design/scripts/sync.mjs): hash-locked, never edited here.
    "src/sarib/**",
  ]),
]);

export default eslintConfig;
