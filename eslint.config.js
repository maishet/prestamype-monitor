import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".aws-sam/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
