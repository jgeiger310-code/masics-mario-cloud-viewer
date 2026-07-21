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
  {
    files: ["assets/**/*.js", "tests/**/*.mjs", "tools/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: sharedGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: "warn"
    },
    rules: {
      "constructor-super": "error",
      "for-direction": "error",
      "getter-return": "error",
      "no-async-promise-executor": "error",
      "no-case-declarations": "error",
      "no-class-assign": "error",
      "no-compare-neg-zero": "error",
      "no-cond-assign": ["error", "except-parens"],
      "no-const-assign": "error",
      "no-constant-binary-expression": "error",
      "no-constant-condition": ["error", { "checkLoops": false }],
      "no-control-regex": "error",
      "no-debugger": "warn",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-dupe-else-if": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-empty-character-class": "error",
      "no-ex-assign": "error",
      "no-extra-boolean-cast": "error",
      "no-fallthrough": "error",
      "no-func-assign": "error",
      "no-global-assign": "error",
      "no-import-assign": "error",
      "no-irregular-whitespace": "error",
      "no-loss-of-precision": "error",
      "no-misleading-character-class": "error",
      "no-new-native-nonconstructor": "error",
      "no-obj-calls": "error",
      "no-prototype-builtins": "warn",
      "no-redeclare": "error",
      "no-regex-spaces": "error",
      "no-self-assign": "error",
      "no-setter-return": "error",
      "no-shadow-restricted-names": "error",
      "no-sparse-arrays": "error",
      "no-this-before-super": "error",
      "no-undef": "warn",
      "no-unexpected-multiline": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "no-unused-labels": "error",
      "no-useless-backreference": "error",
      "require-yield": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-console": "off",
      "no-unused-vars": "off"
    }
  }
];
