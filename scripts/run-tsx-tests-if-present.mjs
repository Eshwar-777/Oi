#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [, , rootDir, suffix] = process.argv;

if (!rootDir || !suffix) {
  console.error("Usage: node scripts/run-tsx-tests-if-present.mjs <rootDir> <suffix>");
  process.exit(1);
}

function collectMatches(dir, targetSuffix, matches) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMatches(fullPath, targetSuffix, matches);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(targetSuffix)) {
      matches.push(fullPath);
    }
  }
}

const absoluteRoot = path.resolve(process.cwd(), rootDir);
const matches = [];

if (statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) {
  collectMatches(absoluteRoot, suffix, matches);
}

if (matches.length === 0) {
  console.log(`No matching test files found under ${rootDir} for *${suffix}; skipping.`);
  process.exit(0);
}

const result = spawnSync("tsx", ["--test", ...matches], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
