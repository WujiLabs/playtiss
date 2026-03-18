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
          AssetId: "playtiss#AssetId",
          TraceId: "playtiss#TraceId",
          ActionId: "playtiss#ActionId",
          SystemActionId: "playtiss#SystemActionId",
          DictJSONAsset: "playtiss#DictAsset",
        },
      },
    },
  },
};

export default config;
