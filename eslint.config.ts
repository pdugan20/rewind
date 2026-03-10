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
        { argsIgnorePattern: '^_' },
      ],
      'drizzle/enforce-delete-with-where': 'error',
      'drizzle/enforce-update-with-where': 'error',
    },
  },
  {
    ignores: ['node_modules/', 'dist/', '.wrangler/', 'migrations/'],
  }
);
