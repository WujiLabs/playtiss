import { defineConfig } from 'eslint/config';
import { mainConfig } from '../eslint.base.mjs';
import nodePath from 'node:path'

export const paths = {
  ignores: ['dist/**', "test/**",'eslint.config.mjs', "**/*.js", 'src/__generated__/*.ts', 'codegen.ts'],
  files: ["src/**/*.ts"],
}

export const config = ({ path = ".", baseConfig, ignores: baseIgnores = [], files: baseFiles = [] }) => {
  const files = [...paths.files, ...baseFiles].map((file) => nodePath.join(path, file))
  const ignores = [...paths.ignores, ...baseIgnores].map((ignore) => nodePath.join(path, ignore))
  const configuredPaths = { files, ignores };
  return defineConfig(
    // custom config before base config
    // { ...configuredPaths },
    // base config
    ...baseConfig({ ...configuredPaths, tsconfigRootDir: import.meta.dirname }),
    // overrides of base config
    // { ...configuredPaths },
  );
}

const defaultConfig = config({baseConfig: mainConfig, ...paths})
// console.log(defaultConfig)

export default defaultConfig;
