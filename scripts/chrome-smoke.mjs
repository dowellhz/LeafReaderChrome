import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const chrome =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = Number(process.env.LEAFREADER_CHROME_PORT || 9228);
const profile = await mkdtemp(
  path.join(os.tmpdir(), "leafreaderchrome-smoke-"),
);
let child;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForServiceWorker() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
        (response) => response.json(),
      );
      const worker = targets.find(
        (target) =>
          target.type === "service_worker" &&
          target.url.includes("chrome-extension://"),
      );
      if (worker) return worker;
    } catch (_) {
      // Chrome's debugging endpoint starts after the process does.
    }
    await delay(250);
  }
  throw new Error(
    "Chrome did not load the extension service worker within 15 seconds.",
  );
}

try {
  child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${root}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const launchError = new Promise((_, reject) => {
    child.once("error", (error) => {
      reject(
        new Error(`Could not start Chrome at ${chrome}: ${error.message}`),
      );
    });
  });
  const worker = await Promise.race([waitForServiceWorker(), launchError]);
  console.log(`Chrome smoke test passed: ${worker.url}`);
} finally {
  child?.kill("SIGTERM");
  await rm(profile, { recursive: true, force: true });
}
