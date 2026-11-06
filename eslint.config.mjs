import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { ignores: [".next/**", ".next-e2e/**", "test-results/**", "node_modules/**", "next-env.d.ts"] },
];

export default config;
