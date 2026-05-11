import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Linting the bundled WebView assets (a copy of dist/) and the
  // Capacitor plugin sources is the build system's job, not ours.
  globalIgnores(['dist', 'android', 'ios']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    // Server-side code (Vercel serverless functions, shared libs, the
    // Docker entrypoint, and the drizzle config) runs in Node, not the
    // browser. Declare node globals for these paths so `process`,
    // `Buffer`, etc. are recognised.
    files: [
      'api/**/*.js',
      'lib/**/*.js',
      'server.js',
      'drizzle.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
])
