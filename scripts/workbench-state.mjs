import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
const root = realpathSync(path.resolve(import.meta.dirname, ".."));
function digest(files) {
  const hash = createHash("sha256");
  for (const file of files.sort())
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(path.join(root, file)))
      .update("\0");
  return hash.digest("hex");
}
function walk(relative) {
  return readdirSync(path.join(root, relative), {
    withFileTypes: true,
  }).flatMap((entry) => {
    if (["node_modules", "dist", ".local"].includes(entry.name)) return [];
    const file = `${relative}/${entry.name}`;
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const packages = walk("packages");
const install = digest([
  "package.json",
  "package-lock.json",
  ...packages.filter((p) => p.endsWith("/package.json")),
]);
const fingerprint = digest([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ...packages,
  ...walk("scripts"),
]);
const checkoutId = createHash("sha256")
  .update(process.platform === "win32" ? root.toLowerCase() : root)
  .digest("hex");
console.log(JSON.stringify({ install, fingerprint, checkoutId }));
