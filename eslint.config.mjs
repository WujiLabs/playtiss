import { defineConfig, globalIgnores } from 'eslint/config'
import nodePath from 'node:path'
import { mainConfig, paths as mainPaths } from './eslint.base.mjs'
import { config as graphqlServerConfig, paths as graphqlServerPaths } from './graphql-server/eslint.config.mjs'
import { config as playtissConfig, paths as playtissPaths } from './src/eslint.config.mjs'
import { config as pipelineRunnerConfig, paths as pipelineRunnerPaths } from './pipeline-runner/eslint.config.mjs'
import { config as typescriptWorkerConfig, paths as typescriptWorkerPaths } from './typescript-worker/eslint.config.mjs'
import { config as compilerConfig, paths as compilerPaths } from './playtiss-compiler/eslint.config.mjs'

const external = {
  graphqlServer: { path: 'graphql-server', ...graphqlServerPaths },
  playtiss: { path: 'src', ...playtissPaths },
  pipelineRunner: { path: 'pipeline-runner', ...pipelineRunnerPaths },
  typescriptWorker: { path: 'typescript-worker', ...typescriptWorkerPaths },
  compiler: { path: 'playtiss-compiler', ...compilerPaths },
}

const externalIgnores = Object.values(external).flatMap(({ path, ignores }) => ignores.map(ignore => nodePath.join(path, ignore)))
const externalFiles = Object.values(external).flatMap(({ path, files }) => files.map(file => nodePath.join(path, file)))

export default defineConfig(
  globalIgnores(mainPaths.ignores),
  // main config with ignored external files & ignores
  ...mainConfig({
    files: mainPaths.files,
    ignores: [...externalIgnores, ...externalFiles],
    tsConfigRootDir: import.meta.dirname,
  }),
  // external config with path, main config, files, and ignores
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
)
