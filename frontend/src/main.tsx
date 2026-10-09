import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./components/Dashboard";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
