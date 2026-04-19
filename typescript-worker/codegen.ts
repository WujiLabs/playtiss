import type { CodegenConfig } from "@graphql-codegen/cli";

// Use local v3.1 GraphQL schema
const SCHEMA_PATH = "../graphql-server/schema.graphql";

const config: CodegenConfig = {
  overwrite: true,
  schema: SCHEMA_PATH,
  documents: ["src/**/*.ts"],
  emitLegacyCommonJSImports: false,
  generates: {
    "./src/__generated__/": {
      preset: "client",
      config: {
        useTypeImports: true,
        enumsAsTypes: true,
        scalars: {
          Date: "number",
          AssetId: "@playtiss/core#AssetId",
          TraceId: "@playtiss/core#TraceId",
          ActionId: "@playtiss/core#ActionId",
          SystemActionId: "@playtiss/core#SystemActionId",
          DictJSONAsset: "@playtiss/core#DictAsset",
        },
      },
    },
  },
};

export default config;
