import { Application, Text } from "pixi.js";
import "./style.css";

async function startApp(): Promise<void> {
  const mount = document.querySelector<HTMLElement>("#app");
  if (!mount) {
    throw new Error("Missing #app mount element");
  }

  const app = new Application();
  await app.init({
    resizeTo: window,
    antialias: true,
    background: "#f4f6f8",
  });

  app.canvas.setAttribute("aria-label", "Project-TRW P0 map canvas");
  mount.appendChild(app.canvas);

  const placeholder = new Text({
    text: "Project-TRW P0",
    style: {
      fill: 0x25313c,
      fontFamily: "system-ui, sans-serif",
      fontSize: 28,
      fontWeight: "600",
    },
  });
  placeholder.anchor.set(0.5);

  const centerPlaceholder = (): void => {
    placeholder.position.set(app.screen.width / 2, app.screen.height / 2);
  };

  centerPlaceholder();
  app.stage.addChild(placeholder);
  window.addEventListener("resize", centerPlaceholder);
}

void startApp();
