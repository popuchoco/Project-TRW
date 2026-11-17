import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/sim/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Simulation results must be deterministic." },
        { object: "Date", property: "now", message: "Simulation code must not read system time." },
        { object: "performance", property: "now", message: "Simulation code must not read system time." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "Simulation code must not read system time." },
        { name: "performance", message: "Simulation code must not read system time." },
      ],
    },
  },
);
