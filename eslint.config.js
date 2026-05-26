import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },

  {
    files: ['src/**/*.ts'],
    ignores: ['src/ui/**'],
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      // Wolfi's nodejs-24 build crashes with SIGILL when undici (the
      // native fetch implementation) hits certain SIMD/crypto paths on
      // ARM64 (Cortex-A76 / Pi 5). Use httpFetch from utils/http-client.ts
      // instead — it uses Node's classic http/https modules. See 0.6.4
      // healthcheck fix and 0.6.5 gdrive-auth fix.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use httpFetch from utils/http-client.js instead.' },
      ],
    },
  },

  {
    files: ['*.config.js', '*.config.ts', 'eslint.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    ignores: ['dist/**', 'node_modules/**', 'src/ui/**', 'src/static/**', '*.min.js'],
  }
);
