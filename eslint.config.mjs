// Minimal lint guard.
//
// Primary purpose: catch undefined identifiers and other low-cost correctness regressions.
// The remote Docker gateway is linted with the same rules as the MCP implementation.
export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly',
        process: 'readonly', Buffer: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', WebSocket: 'readonly', AbortController: 'readonly',
        AbortSignal: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        global: 'readonly', __dirname: 'readonly', structuredClone: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
];
