import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
for (const folder of ["src", "bin", "test", "scripts"]) {
  for (const name of readdirSync(folder).filter(name => name.endsWith(".mjs"))) {
    const result = spawnSync(process.execPath, ["--check", join(folder, name)], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
