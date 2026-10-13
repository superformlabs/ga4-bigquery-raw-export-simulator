// `npm run dev`: start the mock API and Next.js together with one command.
//
//   PORT       the UI port (default 3000)
//   MOCK_PORT  the mock API port (default PORT + 1, so several Conductor
//              workspaces can run side by side without touching port 3001)
//
// To run the UI against the real backend instead, use `npm run dev:live`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const uiPort = Number(process.env.PORT ?? 3000);
const mockPort = Number(process.env.MOCK_PORT ?? uiPort + 1);

const children = [];

function start(name, cmd, args, env) {
  const child = spawn(cmd, args, { cwd: webDir, stdio: "inherit", env: { ...process.env, ...env } });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited with code ${code}`);
    stopAll();
    process.exit(code ?? 1);
  });
  children.push(child);
}

function stopAll() {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
}
process.on("SIGINT", () => { stopAll(); process.exit(0); });
process.on("SIGTERM", () => { stopAll(); process.exit(0); });

start("mock api", process.execPath, [path.join(here, "server.mjs")], { MOCK_PORT: String(mockPort) });
// Resolve the Next.js CLI through module resolution: npm workspaces hoist it to the root node_modules.
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
start("next", process.execPath, [nextBin, "dev", "--port", String(uiPort)], {
  PORT: String(uiPort),
  API_URL: `http://localhost:${mockPort}`,
});
console.log(`[dev] UI on http://localhost:${uiPort}, mock API on http://localhost:${mockPort}`);
