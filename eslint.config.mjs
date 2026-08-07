import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "apps/web/worker/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.mjs", "**/*.config.ts"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        AbortSignal: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    files: [
      "**/*.config.{js,mjs,ts}",
      "**/*.test.{ts,tsx}",
      "**/tests/**/*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
