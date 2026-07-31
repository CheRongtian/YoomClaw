import { createRoot } from "react-dom/client";
import ChatPage from "./components/ChatPage";
import "./globals.css";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";

const container = document.getElementById("root");
if (!container) throw new Error("root container missing");

createRoot(container).render(<ChatPage />);
