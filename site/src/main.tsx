import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    {/* Vercel's cookieless page views and web vitals; both stay silent off Vercel. */}
    <Analytics />
    <SpeedInsights />
  </StrictMode>,
);
