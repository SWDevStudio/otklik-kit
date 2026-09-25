#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { PROFILE, read, profileState, statusLine } from "./lib.mjs";

if (process.argv.includes("--stamp")) {
  const { want } = profileState();
  const prof = read(PROFILE);
  if (!want || !prof) {
    console.log("нечего штамповать: нет резюме или профиля");
    process.exit(1);
  }
  const next = prof.replace(/sha256:[0-9a-f]{64}|sha256:pending/, "sha256:" + want).replace(/generated: \d{4}-\d{2}-\d{2}/, "generated: " + new Date().toISOString().slice(0, 10));
  writeFileSync(PROFILE, next);
}
console.log(statusLine());
