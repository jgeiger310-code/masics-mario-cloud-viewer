import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";

const allowedMigration = /everwild[-_/]?(split|migration)|split[-_/]?everwild/i;
const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main";

let changed = "";
try {
  changed = execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" });
} catch {
  changed = execSync("git diff --name-only --cached", { encoding: "utf8" });
}

const changedFiles = changed.split(/\r?\n/).filter(Boolean);
const everwildChanges = changedFiles.filter((file) => file.startsWith("everwild/"));

assert.ok(
  !everwildChanges.length || allowedMigration.test(branch),
  `Everwild files changed on a MASICS branch without an explicit migration branch name: ${everwildChanges.join(", ")}`
);

const masicsEntrypoints = ["index.html", "fresh.html", "tracker.html"]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");

assert.doesNotMatch(masicsEntrypoints, /everwild/i, "MASICS viewer entrypoints must not reference Everwild assets or routes.");

console.log("PASS project separation guard");
