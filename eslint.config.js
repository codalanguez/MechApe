/**
 * eslint.config.js — a deliberately small rule set aimed at real bugs.
 *
 * This exists because of one that shipped. `electron/settings.js` had:
 *
 *     const env = env('FS_ROOTS');
 *
 * The local binding shadows the module's env() helper across the whole
 * function body, so the call meant to initialise it resolves to the
 * not-yet-initialised local and throws at runtime. It sat on the boot path,
 * so the forked server died before listening and the packaged app hung on
 * its splash screen forever. It is syntactically valid, so `node --check`
 * was blind to it, and nothing in `npm test` loads electron/ — only a linter
 * or an actual launch could catch it.
 *
 * The rules below are limited to that class of problem: things that are
 * legal JavaScript and wrong. Style is left alone on purpose — this runs in
 * `npm test`, and a lint step that cries about formatting is a lint step
 * people learn to skip.
 */
const globals = require('globals');

const bugRules = {
  // the one that shipped
  'no-shadow': 'error',
  // the same bug from the other direction — using a binding before its
  // declaration is evaluated. `functions: false` keeps hoisted function
  // declarations legal, which this codebase uses deliberately.
  'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],

  // typos in identifiers, and globals that only exist in the other runtime
  'no-undef': 'error',
  // caught dead code during the Ollama removal; args are noisier than they
  // are useful for callback-heavy code, so only flag unused locals.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],

  // assorted "legal but almost certainly a mistake"
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-unsafe-negation': 'error',
  'no-unreachable': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'valid-typeof': 'error',
  'use-isnan': 'error',
  eqeqeq: ['error', 'smart'],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',              // electron-builder output
      'electron/runtime/**',  // vendored llama.cpp builds
      'logs/**',
      'data/**',
    ],
  },

  // Node: the server, the domain modules, the desktop main process, build scripts.
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: bugRules,
  },

  // The web UI. main.js and everything it pulls in are ES modules
  // (<script type="module">), running in the renderer.
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: bugRules,
  },

  // theme-boot.js is loaded as a classic <script> before the module graph, so
  // it must stay parseable as a plain script.
  {
    files: ['public/js/theme-boot.js'],
    languageOptions: { sourceType: 'script' },
  },

  // The preload bridge runs in an isolated world: Node's require plus a
  // little DOM.
  {
    files: ['electron/preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
