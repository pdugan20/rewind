import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import drizzle from 'eslint-plugin-drizzle';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: {
      drizzle,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'drizzle/enforce-delete-with-where': 'error',
      'drizzle/enforce-update-with-where': 'error',
    },
  },
  // zod-openapi route handlers require `as any` casts on return types
  {
    files: ['src/routes/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Test files intentionally delete all rows for cleanup
  {
    files: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    rules: {
      'drizzle/enforce-delete-with-where': 'off',
    },
  },
  {
    ignores: [
      'node_modules/',
      'dist/',
      'mcp-server/',
      '.wrangler/',
      'migrations/',
      'docs-site/',
      'scripts/',
    ],
  }
);
