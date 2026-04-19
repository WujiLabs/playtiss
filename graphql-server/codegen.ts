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
          ActionId: "@playtiss/core#ActionId",
          AssetId: "@playtiss/core#AssetId",
          SystemActionId: "@playtiss/core#SystemActionId",
          TraceId: "@playtiss/core#TraceId",
          Date: "number",
          DictJSONAsset: "@playtiss/core#DictAsset",
        },
      },
    },
  },
};

export default config;
