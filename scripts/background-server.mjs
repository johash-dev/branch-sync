import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const report = (error) =>
  appendFileSync(
    path.join(root, ".local/server-error.log"),
    `${error.stack || error}\n`,
  );
process.env.SYNC_BACKGROUND = "1";
process.on("uncaughtExceptionMonitor", report);
try {
  await import(
    pathToFileURL(path.join(root, "packages/server/dist/index.js")).href
  );
} catch (error) {
  report(error);
  process.exitCode = 1;
}
