import { defineConfig } from "tsup";

// Windows exe 打包专用：CJS 单文件全量内联依赖
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  sourcemap: false,
  clean: true,
  publicDir: "public",
  noExternal: [/./],
});