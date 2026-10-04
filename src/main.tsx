import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-sans-condensed/700.css";
import "@/styles/nuthatch-power.css";
import "@/styles/app/tokens.css";
import "@/styles/app/base.css";
import "@/styles/app/kinds.css";
import "@/styles/app/shell.css";
import "@/styles/app/navigator.css";
import "@/styles/app/object-page.css";
import "@/styles/app/workbench.css";
import "@/styles/app/code.css";
import "@/styles/app/layout-detail.css";
import "@/styles/app/graphs.css";
import "@/styles/app/report-card.css";
import "@/styles/app/dashboard.css";
import "@/styles/app/comparison.css";
import "@/styles/app/motion.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
