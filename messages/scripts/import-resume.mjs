#!/usr/bin/env bun
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { RESUME, fwd, read } from "./lib.mjs";
import { extractFile } from "./extract.mjs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) {
  console.log("usage: bun messages/scripts/import-resume.mjs <резюме.docx|.pdf|.txt|.md|.html> [--force]");
  process.exit(1);
}
if (read(RESUME).trim() && !argv.includes("--force")) {
  console.log(`resume: ${fwd(RESUME)} уже заполнен, --force перезапишет`);
  process.exit(1);
}
try {
  const v = extractFile(resolve(file));
  writeFileSync(RESUME, v.text.trim() + "\n");
  console.log(`resume: ${fwd(RESUME)} | ${v.text.length} симв. | ${v.method}${existsSync(RESUME) ? "" : " | не записан"}`);
} catch (e) {
  console.log("resume: " + e.message);
  process.exit(1);
}
