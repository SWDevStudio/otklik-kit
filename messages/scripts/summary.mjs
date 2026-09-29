#!/usr/bin/env bun
import { readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { OUT, JOBS, fwd, read, runDir, parseDoc, formatDoc, parseKeyLines, jobFile } from "./lib.mjs";
import { atsResumes } from "./ats-core.mjs";

// Строка ATS: каким резюме откликаться (на площадке) и каких навыков вакансии в нём нет.
const resumeTitle = Object.fromEntries(atsResumes().map((r) => [r.name, r.title || r.name]));
const atsLine = (h) => (h.ats === undefined ? [] : [`ATS: ${h.ats} по резюме «${resumeTitle[h.ats_resume] || h.ats_resume}»${h.board ? ", откликайтесь им" : ""}${h.ats_missing?.length ? `; нет в резюме: ${h.ats_missing.join(", ")}` : ""}`]);

const FIRST_CHECK = "Перепишите своими словами хотя бы одну фразу: письма с ручной правкой работают лучше.";
const LETTER_HEADER = "## Сопроводительное письмо";

function listBlock(text, name) {
  const m = text.match(new RegExp(`^${name}:\\s*\\n((?:[ \\t]*- .*\\n?)+)`, "m"));
  return m ? m[1].split("\n").map((l) => l.trim().replace(/^- /, "")).filter((l) => l && !/^(нет|-)$/i.test(l)) : [];
}

function section(text, title) {
  const m = text.match(new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"));
  return m ? m[1].trim() : "";
}

function info(dir) {
  const { head } = parseDoc(read(join(dir, "vacancy.md")));
  const report = read(join(dir, "report.md"));
  const kv = parseKeyLines(report);
  const gate = existsSync(join(dir, "gate.json")) ? JSON.parse(read(join(dir, "gate.json"))) : null;
  return { dir, slug: basename(dir), head, report, kv, gate, letter: read(join(dir, "letter.md")).trim() };
}

function extras(r) {
  const checks = [FIRST_CHECK, ...listBlock(r.report, "checks")];
  if (r.head.test_required) checks.push("В отклике есть тест работодателя: пройдите его вручную на площадке.");
  return { checks, decisions: listBlock(r.report, "decisions").slice(0, 4), questions: listBlock(r.report, "questions").slice(0, 3) };
}

function statusText(r) {
  return [
    `гейт ${r.gate?.gate || r.kv.gate || "?"}`,
    r.kv.facts && `факты ${r.kv.facts}`,
    r.kv.employer && `работодатель ${r.kv.employer}`,
    r.gate?.scanner?.adjusted !== undefined && `чистота ${r.gate.scanner.adjusted}`,
    r.gate && `слов ${r.gate.words}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function noLetterReason(r) {
  if (r.head.ok === false) return `текст вакансии не получен: ${r.head.error || "причина неизвестна"}`;
  if (/^(no|low)/.test(r.kv.fit || "")) return `вакансия не подходит: ${r.kv.fit.replace(/^(no|low)\s*/, "").replace(/^[(:]\s*|\)$/g, "") || "см. report.md"}`;
  if (r.head.archived) return "вакансия в архиве";
  return "письмо не готово, агент не дошёл до конца";
}

function syncJob(r) {
  const file = jobFile(r.slug);
  if (!existsSync(file)) return "";
  const doc = parseDoc(read(file));
  const base = doc.body.split(LETTER_HEADER)[0].trim();
  let status;
  let tail;
  if (r.letter) {
    const x = extras(r);
    status = "letter";
    tail = [LETTER_HEADER, "", r.letter, "", `Вложение: ${r.head.attach || "-"}`, ...atsLine(r.head), "", "Перед отправкой:", ...x.checks.map((c) => "- " + c)];
    if (x.decisions.length) tail.push("", "Агент решил сам:", ...x.decisions.map((c) => "- " + c));
    if (x.questions.length) tail.push("", "Что усилит письмо:", ...x.questions.map((c) => "- " + c));
    tail.push("", `Статус: ${statusText(r)}. Отчёт: ${fwd(join(r.dir, "report.md"))}`);
  } else if (r.head.ok === false || /^(no|low)/.test(r.kv.fit || "") || r.head.archived) {
    status = "skip";
    tail = [LETTER_HEADER, "", "Письма нет: " + noLetterReason(r) + "."];
  } else return fwd(file);
  const target = status === "letter" ? join(JOBS, "_" + r.slug + ".md") : join(JOBS, r.slug + ".md");
  writeFileSync(target, formatDoc({ ...doc.head, status }, base + "\n\n" + tail.join("\n")));
  if (target !== file) rmSync(file, { force: true });
  return fwd(target);
}

const argv = process.argv.slice(2);
const brief = argv.includes("--brief");
const dirs = argv.filter((a) => !a.startsWith("--")).map((a) => runDir(a));
const all = existsSync(OUT)
  ? readdirSync(OUT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(OUT, d.name, "vacancy.md")))
      .map((d) => info(join(OUT, d.name)))
  : [];
const runSlugs = new Set(dirs.map((d) => basename(d)));
const jobFiles = new Map(all.filter((r) => runSlugs.has(r.slug)).map((r) => [r.slug, syncJob(r)]));

const out = [];
dirs.forEach((dir, i) => {
  const r = info(dir);
  const name = [r.head.company || r.head.channel_name, r.head.title].filter(Boolean).join(", ") || r.head.source || r.slug;
  const n = `${i + 1}. ${name} (${r.head.channel || "?"})`;
  const where = jobFiles.get(r.slug) || fwd(dir);
  if (brief) {
    out.push(`${n} | ${r.letter ? statusText(r) : "письма нет: " + noLetterReason(r)} | ${where}`);
    return;
  }
  if (!r.letter) {
    const extra = r.head.ok === false ? ` Вставьте текст в ${fwd(join(dir, "vacancy.md"))} под первой строкой и запустите команду с той же ссылкой.` : /^(no|low)/.test(r.kv.fit || "") ? " Запустите с --force, если письмо всё же нужно." : "";
    out.push(`## ${n}: письма нет`, noLetterReason(r) + "." + extra, "");
    return;
  }
  const x = extras(r);
  out.push(`## ${n}`, "", r.letter, "", `Вложение: ${r.head.attach || "-"}`, ...atsLine(r.head));
  if (r.head.channel === "email" && r.head.apply_email) out.push(`Куда: ${r.head.apply_email}`);
  if (r.head.channel === "telegram" && r.head.apply_tg) out.push(`Кому: ${r.head.apply_tg}`);
  out.push("Перед отправкой:", ...x.checks.map((c) => "- " + c));
  if (x.decisions.length) out.push("Агент решил сам:", ...x.decisions.map((c) => "- " + c));
  if (x.questions.length) out.push("Что усилит письмо:", ...x.questions.map((c) => "- " + c));
  const disputed = section(r.report, "Спорное");
  const more = disputed && !/^(нет|-)\.?$/i.test(disputed) ? ", спорное в report.md" : "";
  out.push(`Статус: ${statusText(r)}${more} | ${where}`, "");
});
console.log(out.join("\n").trim() || "нечего показать");

if (all.length) {
  const rows = all.sort((a, b) => String(b.head.fetched || "").localeCompare(String(a.head.fetched || "")));
  const cell = (s) => String(s || "-").replace(/\|/g, "/").replace(/\n/g, " ");
  const table = [
    "| дата | компания | должность | канал | письмо | гейт | факты | работодатель | каталог |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      "| " +
      [r.head.fetched, r.head.company || r.head.channel_name, r.head.title, r.head.channel, r.letter ? "есть" : r.head.ok === false ? "нет текста" : /^(no|low)/.test(r.kv.fit || "") ? "не подходит" : "нет", r.gate?.gate || r.kv.gate, r.kv.facts, r.kv.employer, `[${r.slug}](${r.slug}/)`]
        .map(cell)
        .join(" | ") +
      " |"
    ),
  ];
  writeFileSync(join(OUT, "index.md"), "# Отклики\n\n" + table.join("\n") + "\n");
}
