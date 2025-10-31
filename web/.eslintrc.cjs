module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "react"],
  env: { browser: true, node: true, es2022: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended"
  ],
  settings: {
    react: { version: "detect" }  // JSX 自動ランタイムでもOK
  },
  rules: {
    "react/react-in-jsx-scope": "off",
    "react/jsx-uses-react": "off",
    "@typescript-eslint/no-unused-vars": ["error", {
      "varsIgnorePattern": "^_",
      "argsIgnorePattern": "^_",
      "caughtErrorsIgnorePattern": "^_"
    }]
  },
  overrides: [
    { files: ["**/*.{js,jsx,ts,tsx}"] }
  ],
  ignorePatterns: ["**/node_modules/**", ".next/**", "dist/**", "out/**", "build/**"]
};
