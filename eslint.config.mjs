import js from "@eslint/js";
import globals from "globals";

const sharedGlobals = {
  ...globals.browser,
  ...globals.node,
  Headers: "readonly",
  Response: "readonly",
  Request: "readonly",
  Blob: "readonly",
  File: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  crypto: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  structuredClone: "readonly",
  XLSX: "readonly",
  mammoth: "readonly",
  pdfjsLib: "readonly",
  JSZip: "readonly",
  saveAs: "readonly"
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "assets/vendor/**",
      "**/*.min.js",
      "**/*.map"
    ]
  },
  js.configs.recommended,
  {
    files: ["assets/**/*.js", "tests/**/*.mjs", "tools/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: sharedGlobals
    },
    rules: {
      "no-console": "off",
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-unused-vars": [
        "warn",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ]
    }
  }
];
