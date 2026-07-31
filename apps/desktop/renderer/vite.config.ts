import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React 插件 + styled-jsx Babel 插件（聊天组件用 <style jsx>）。
// 渲染器直连同机 Gateway（http://localhost:18789），不经代理。
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ["styled-jsx/babel"],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
