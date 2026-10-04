#!/usr/bin/env bun
// Отметка «откликнулся»: ссылка уходит в messages/history.md, папка out/<slug> и файл jobs/<slug>.md удаляются.
//   bun messages/scripts/applied.mjs <ссылка|папка|slug> ... [--dry]
//   bun messages/scripts/applied.mjs sync [--dry]    все отклики hh из аккаунта (Chrome с входом: hh-resume.mjs login)
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, resolve, relative } from "node:path";
import { MSG, OUT, JOBS, fwd, read, parseDoc } from "./lib.mjs";
import { classify, historySlugs } from "./extract.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const items = args.filter((a) => !a.startsWith("--"));
const HISTORY = join(MSG, "history.md");
const HEAD =
  "# История откликов: ссылки на вакансии, на которые уже откликнулись.\n# Папку в out/ и файл в jobs/ после отклика можно удалять. Поиск и fetch пропускают вакансии из этого файла.\n# Формат строки: ссылка | компания | должность (компания и должность не обязательны).\n\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAFE = /^[\w.-]+$/;

if (!items.length) {
  console.log("applied: укажите ссылку, папку или slug вакансии, либо sync для сверки с откликами на hh");
  process.exit(2);
}

function resolveSource(src) {
  let dir = "";
  if (SAFE.test(src) && existsSync(join(OUT, src, "vacancy.md"))) dir = join(OUT, src);
  else if (!/^https?:\/\//i.test(src)) {
    const p = resolve(src.replace(/[\\/]?(vacancy|letter)\.md$/, ""));
    const rel = relative(OUT, p);
    if (rel && !rel.startsWith("..") && !/[\\/]/.test(rel) && existsSync(join(p, "vacancy.md"))) dir = p;
  }
  if (dir) {
    const h = parseDoc(read(join(dir, "vacancy.md"))).head;
    return { slug: basename(dir), url: h.url || "", company: h.company || "", title: h.title || "" };
  }
  const s = classify(src);
  if (!s.url) return { slug: s.slug, url: "", company: "", title: "" };
  const vf = join(OUT, s.slug, "vacancy.md");
  const h = existsSync(vf) ? parseDoc(read(vf)).head : {};
  return { slug: s.slug, url: s.url, company: h.company || "", title: h.title || "" };
}

const answered = historySlugs();
if (!existsSync(HISTORY) && !dry) writeFileSync(HISTORY, HEAD);

function record(e) {
  if (!e.url || !SAFE.test(e.slug)) return { line: `fail | ${e.slug || "-"} | не понял источник: нужна ссылка на вакансию или папка из out/` };
  const notes = [];
  let wrote = false;
  let removed = 0;
  if (!answered.has(e.slug)) {
    const line = e.company || e.title ? `${e.url} | ${e.company} | ${e.title}` : e.url;
    if (!dry) appendFileSync(HISTORY, line + "\n");
    answered.add(e.slug);
    wrote = true;
    notes.push("записано в history");
  } else notes.push("уже в history");
  // удаляются только папка out/<slug> и файлы jobs/<slug>.md, имя slug проверено на безопасность
  for (const p of [join(OUT, e.slug), join(JOBS, "_" + e.slug + ".md"), join(JOBS, e.slug + ".md")]) {
    if (!existsSync(p)) continue;
    if (!dry) rmSync(p, { recursive: true, force: true });
    removed++;
    notes.push("удалено " + fwd(relative(MSG, p)));
  }
  return { line: `${dry ? "dry " : "ok  "} | ${e.slug} | ${notes.join(", ")}`, wrote, removed };
}

if (items[0] === "sync") {
  const { connect } = await import("./hh/cdp.mjs");
  const page = await connect();
  const ids = [];
  for (let p = 0; p < 30; p++) {
    await page.goto("https://hh.ru/applicant/negotiations?page=" + p, "body");
    await sleep(2500);
    if (/account\/login/.test(await page.url())) {
      console.log("applied: вход в hh не выполнен: войдите в окне браузера (hh-resume.mjs login) и повторите");
      process.exit(1);
    }
    const found = await page.eval(() => [...new Set([...document.querySelectorAll('a[href*="/vacancy/"]')].map((a) => (a.href.match(/\/vacancy\/(\d+)/) || [])[1]).filter(Boolean))]);
    const fresh = found.filter((i) => !ids.includes(i));
    if (!fresh.length) break;
    ids.push(...fresh);
  }
  let wrote = 0;
  let removed = 0;
  for (const id of ids) {
    const r = record(resolveSource("https://hh.ru/vacancy/" + id));
    if (r.wrote || r.removed) console.log(r.line);
    wrote += r.wrote ? 1 : 0;
    removed += r.removed || 0;
  }
  console.log(`applied: откликов на hh ${ids.length}, новых в history ${wrote}, удалено папок и файлов ${removed}${dry ? " (dry: ничего не изменено)" : ""}`);
  process.exit(0);
}

for (const src of items) console.log(record(resolveSource(src)).line);
