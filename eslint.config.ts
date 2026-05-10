import antfu from "@antfu/eslint-config";

export default antfu({
  typescript: true,
  react: true,
  stylistic: {
    indent: 2,
    quotes: "double",
    semi: true,
  },
  rules: {
    "no-console": "warn",
    "ts/no-explicit-any": "error",
    "ts/consistent-type-imports": ["error", { prefer: "type-imports" }],
  },
  ignores: [
    "**/*.json",
    "**/*.toml",
    "apps/api/drizzle/**",
    "apps/web/src/shared/components/ui/**",
    "apps/web/src/app/routeTree.gen.ts",
  ],
});
