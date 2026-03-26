import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import tseslint from 'typescript-eslint'

export const paths = {
  ignores: [
    '**/dist/**',
    '**/build/**',
  ],
  files: [
    '**/*.js', '**/*.ts', '**/*.tsx', '**/*.cjs', '**/*.mjs',
  ],
}

export function mainConfig({ files = [], ignores = [], tsconfigRootDir }) {
  return defineConfig(
    {
      extends: [
        stylistic.configs.recommended,
        js.configs.recommended,
        tseslint.configs.recommended,
      ],
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // for typescript-eslint
        parserOptions: {
          project: true,
          tsconfigRootDir,
        },
      },
      plugins: {
        'simple-import-sort': simpleImportSort,
      },
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        }],
        'simple-import-sort/imports': 'error',
        'simple-import-sort/exports': 'error',
      },
      files,
      ignores,
    },
  )
};
