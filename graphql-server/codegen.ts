import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  overwrite: true,
  schema: "./schema.graphql",
  generates: {
    "src/__generated__/graphql.ts": {
      plugins: ["typescript", "typescript-resolvers"],
      config: {
        allowEnumStringTypes: true,
        useTypeImports: true, // Enable type-only imports
        scalars: {
          ActionId: "playtiss#ActionId",
          AssetId: "playtiss#AssetId",
          SystemActionId: "playtiss#SystemActionId",
          TraceId: "playtiss#TraceId",
          Date: "number",
          DictJSONAsset: "playtiss#DictAsset",
        },
      },
    },
  },
};

export default config;
