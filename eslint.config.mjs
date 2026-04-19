import nodePath from 'node:path'

import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import { config as cliConfig, paths as cliPaths } from './cli/eslint.config.mjs'
import { mainConfig, paths as mainPaths } from './eslint.base.mjs'
import { config as graphqlServerConfig, paths as graphqlServerPaths } from './graphql-server/eslint.config.mjs'
import { config as pipelineRunnerConfig, paths as pipelineRunnerPaths } from './pipeline-runner/eslint.config.mjs'
import { config as compilerConfig, paths as compilerPaths } from './playtiss-compiler/eslint.config.mjs'
import { config as coreConfig, paths as corePaths } from './playtiss-core/eslint.config.mjs'
import { config as playtissConfig, paths as playtissPaths } from './src/eslint.config.mjs'
import { config as typescriptWorkerConfig, paths as typescriptWorkerPaths } from './typescript-worker/eslint.config.mjs'

const external = {
  core: { path: 'playtiss-core', ...corePaths },
  graphqlServer: { path: 'graphql-server', ...graphqlServerPaths },
  playtiss: { path: 'src', ...playtissPaths },
  pipelineRunner: { path: 'pipeline-runner', ...pipelineRunnerPaths },
  typescriptWorker: { path: 'typescript-worker', ...typescriptWorkerPaths },
  compiler: { path: 'playtiss-compiler', ...compilerPaths },
  cli: { path: 'cli', ...cliPaths },
}

const externalIgnores = Object.values(external).flatMap(({ path, ignores }) => ignores.map(ignore => nodePath.join(path, ignore)))
const externalFiles = Object.values(external).flatMap(({ path, files }) => files.map(file => nodePath.join(path, file)))

export default defineConfig(
  globalIgnores(mainPaths.ignores),
  // main config with ignored external files & ignores
  ...mainConfig({
    files: mainPaths.files,
    ignores: [...externalIgnores, ...externalFiles],
    tsconfigRootDir: import.meta.dirname,
  }),
  {
    files: ['eslint.config.mjs', 'eslint.base.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  { // scripts are not type checked, but with node globals
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  // external config with path, main config, files, and ignores
  ...coreConfig({
    path: external.core.path,
    baseConfig: mainConfig,
    files: mainPaths.files,
  }),
  ...graphqlServerConfig({
    path: external.graphqlServer.path,
    baseConfig: mainConfig,
    files: mainPaths.files,
  }),
  ...playtissConfig({
    path: external.playtiss.path,
    baseConfig: mainConfig,
    files: mainPaths.files,
  }),
  ...pipelineRunnerConfig({
    path: external.pipelineRunner.path,
    baseConfig: mainConfig,
    files: mainPaths.files,
  }),
  ...typescriptWorkerConfig({
    path: external.typescriptWorker.path,
    baseConfig: mainConfig,
    files: mainPaths.files,
  }),
  ...compilerConfig({
    path: external.compiler.path,
    baseConfig: mainConfig,
    files: mainPaths.files,
  }),
  ...cliConfig({
    path: external.cli.path,
    baseConfig: mainConfig,
    files: mainPaths.files,
  }),
)
