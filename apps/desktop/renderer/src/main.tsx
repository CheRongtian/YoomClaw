import { createRoot } from "react-dom/client";
import ChatPage from "./components/ChatPage";
import { ThemeProvider } from "./theme/ThemeProvider";
import { applyInitialTheme } from "./theme/themes";
import "./globals.css";
import "katex/dist/katex.min.css";

// 在 React 挂载前同步应用已保存的主题，避免首帧闪烁
applyInitialTheme();

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");

createRoot(container).render(
  <ThemeProvider>
    <ChatPage />
  </ThemeProvider>,
);
