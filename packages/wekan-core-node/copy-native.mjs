import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const dest = join(here, "wekan-core-node.node");
const candidates = [
  join(root, "target/release/libwekan_core_node.so"),
  join(root, "target/release/libwekan_core_node.dylib"),
  join(root, "target/release/wekan_core_node.dll"),
];

const src = candidates.find((path) => existsSync(path));
if (!src) {
  throw new Error(
    `wekan-core-node native library not found. Tried:\n${candidates.join("\n")}`,
  );
}
copyFileSync(src, dest);
console.log(`copied ${src} -> ${dest}`);
