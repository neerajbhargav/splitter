import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Apostrophes and quotes render fine in JSX text; still catch a stray > or }.
      "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
      // `const { [key]: _gone, ...rest } = obj` drops a key on purpose.
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true, varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      // Editors reset their form when they open. That costs one extra render,
      // not a wrong result, and rewriting them would change live behaviour.
      "react-hooks/set-state-in-effect": "off",
      // Only matters to the React Compiler, which this app does not use.
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "test-results/**", "playwright-report/**", "next-env.d.ts", "public/pdf.worker.min.mjs"]),
]);
