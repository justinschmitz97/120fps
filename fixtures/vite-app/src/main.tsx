import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./theme.scss";
import styles from "./widget.module.css";

function App() {
  return <div className={styles.widget}>vite app fixture</div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
