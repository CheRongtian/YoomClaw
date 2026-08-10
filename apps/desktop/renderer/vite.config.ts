import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React 插件 + styled-jsx Babel 插件（聊天组件用 <style jsx>）。
// 渲染器直连同机 Gateway（http://127.0.0.1:18790），不经代理。
export default defineConfig({
  // The packaged Electron renderer is loaded with file:// via loadFile().
  // Relative asset URLs are required there; absolute /assets URLs resolve
  // against the filesystem root and leave the packaged window blank.
  base: "./",
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
