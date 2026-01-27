import { spawn } from "node:child_process";

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" };

const child = spawn(npxCmd, ["playwright", "install", "chromium"], {
  stdio: "inherit",
  env,
});

child.on("exit", (code) => process.exit(code ?? 1));
