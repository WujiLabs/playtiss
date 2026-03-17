import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig } from 'eslint/config'
import stylistic from '@stylistic/eslint-plugin'

export const paths = {
  ignores: [
    '**/dist/**',
    '**/build/**',
  ],
  files: [
    '**/*.js', '**/*.ts', '**/*.tsx', '**/*.cjs', '**/*.mjs'
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
        ecmaVersion: "latest",
        sourceType: "module",
        // for typescript-eslint
        parserOptions: {
          project: true,
          tsconfigRootDir,
        }
      },
      files,
      ignores,
    }
  );
};
