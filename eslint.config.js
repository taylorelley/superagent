import js from '@eslint/js';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  fetch: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  WebSocket: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

export default [
  js.configs.recommended,

  {
    ignores: ['node_modules/**', 'tests/brainstorm-server/node_modules/**', '.worktrees/**'],
  },

  // Everything under package.json's "type": "module" scope, plus explicit
  // .mjs files anywhere: ESM, Node globals.
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['tests/brainstorm-server/**/*.js', 'skills/brainstorming/scripts/helper.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },

  // tests/brainstorm-server carries its own package.json with no "type"
  // field, so its .js files are CommonJS (they use require()), and
  // skills/brainstorming/scripts/server.cjs is CommonJS by extension.
  {
    files: ['tests/brainstorm-server/**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, require: 'readonly', module: 'readonly', exports: 'writable' },
    },
  },

  // Served directly to a browser by the brainstorm server, but also
  // `require()`d by helper.test.js under Node — a `typeof module !==
  // 'undefined'` guard picks the environment at load time, so both
  // `module` and the browser globals are legitimately referenced here.
  {
    files: ['skills/brainstorming/scripts/helper.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...browserGlobals, module: 'readonly' },
    },
  },

  {
    rules: {
      // This codebase deliberately favors terse one-off names in short
      // callbacks and destructures (record.state, err), which
      // no-unused-vars already covers; the base recommended set is enough
      // without adding style opinions this project hasn't asked for.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // "best effort, ignore the failure" catch blocks are a deliberate,
      // repeated idiom here (cleanup, chmod, port/token probing) — the
      // option exists precisely so this doesn't need a placeholder comment
      // at every call site.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
