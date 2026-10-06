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
    // A bare function expression evaluated inside the page by Playwright, not a module.
    "scripts/video/layout-qa.js",
    // The Remotion video project has its own package and tsconfig (and generated data).
    "video/remotion/**",
  ]),
]);

export default eslintConfig;
