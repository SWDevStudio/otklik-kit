#!/usr/bin/env bun
// ATS-отчёт: резюме против выборки вакансий (срез рынка из hh-market.mjs). Методика и авторство: ats-core.mjs.
//   bun messages/scripts/ats.mjs --jobs messages/out/market/front.jsonl --resume react --resume vue
//   bun messages/scripts/ats.mjs --jobs messages/out/market/lead.jsonl --resume lead --where "frontend|react|vue"
//   --resume   ключ резюме (messages/resumes/<ключ>.md) или путь к любому .md/.txt
//   --where    регулярное выражение по названию и тегам вакансии (текст не учитывается: там часто «взаимодействие с frontend»)
//   --min-tag  тег считается словарным навыком, если встречается хотя бы в N вакансиях выборки (по умолчанию 3)
// Отчёт: messages/out/ats/<резюме>.<выборка>.md и .json. Только диагностика: навык добавляется в резюме,
// если он правда есть в опыте, формулируется своими словами и не выдумывается.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { OUT, fwd, read } from "./lib.mjs";
import { atsResumes, prepare, skillsFromMd } from "./ats-core.mjs";

const argv = process.argv.slice(2);
const all = (f) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]] : []));
const opt = (f) => all(f)[0] || "";
const jobsFile = opt("--jobs");
const resumeArgs = all("--resume");
const minTag = +(opt("--min-tag") || 3);
if (!jobsFile || !resumeArgs.length) {
  console.log("ats: нужно --jobs <выборка.jsonl> и хотя бы один --resume <ключ|файл>; выборку собирает hh-market.mjs");
  process.exit(1);
}
const known = atsResumes(opt("--dir") || undefined);
const resumes = resumeArgs.map((a) => {
  const r = known.find((x) => x.name === a);
  if (r) return r;
  if (!existsSync(a)) {
    console.log(`ats: нет резюме «${a}»: ни messages/resumes/${a}.md, ни такого файла`);
    process.exit(1);
  }
  const text = read(a);
  return { name: basename(a, extname(a)), skills: skillsFromMd(text), text };
});
const where = opt("--where") ? new RegExp(opt("--where"), "iu") : null;
const vacancies = read(jobsFile).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((v) => !where || where.test(v.title + " " + (v.key_skills || []).join(" ")));
if (!vacancies.length) {
  console.log("ats: в выборке нет вакансий" + (where ? " под --where" : ""));
  process.exit(1);
}
const ats = prepare({ resumes, vacancies, minTag });
if (!ats.lemmas) console.log("ats: нет python с razdel и pymorphy3, русские формы слов сравниваются без лемм");

mkdirSync(join(OUT, "ats"), { recursive: true });
const sample = basename(jobsFile, extname(jobsFile)) + (where ? "-" + opt("--where").replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 20) : "");
for (const r of resumes) {
  const per = vacancies.map((v) => ({ v, ...ats.score(r, v) })).map((p) => ({ ...p, score: p.score ?? 0 }));
  per.sort((a, b) => b.score - a.score);
  const scores = per.map((p) => p.score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  const good = per.filter((p) => p.score >= 70).length;
  const withTags = per.filter((p) => p.fieldHit !== null);
  const field = withTags.length ? Math.round((100 * withTags.reduce((a, p) => a + p.fieldHit, 0)) / withTags.length) : 0;
  const need = new Map();
  for (const p of per) for (const k of new Set([...p.tags, ...p.fromText])) need.set(k, (need.get(k) || 0) + 1);
  const pct = (n) => Math.round((100 * n) / per.length);
  const ranked = [...need].sort((a, b) => b[1] - a[1]);
  const skillField = new Set(r.skills.map((s) => ats.groupOf(s)[0]));
  const missing = ranked.filter(([k]) => ats.has(r, k) === 0);
  const thin = ranked.filter(([k]) => ats.has(r, k) === 1);
  const notInField = ranked.filter(([k]) => ats.has(r, k) > 0 && !skillField.has(k) && ats.tagCount.has(k));
  const d = ats.display;
  const line = ([k, n]) => `- ${d(k)}: ${n} (${pct(n)}%)`;
  let md = `# ATS: ${r.name} против ${sample}\n\nВакансий ${per.length}. Оценка вакансии: 0,7 × доля её тегов hh, найденных в резюме, + 0,3 × доля словарных навыков из её текста (словарь: теги, встречающиеся в ${minTag}+ вакансиях выборки).\n\n`;
  md += `- Медиана оценки: **${median}**; вакансий с оценкой 70+: ${good} (${pct(good)}%)\n`;
  md += `- Совпадение поля «Ключевые навыки» резюме с тегами вакансий: в среднем ${field}%${r.skills.length ? ` (в резюме ${r.skills.length} навыков)` : " (поле навыков не найдено)"}\n\n`;
  md += `## Нет в резюме, но нужны вакансиям (доля вакансий)\n\n${missing.slice(0, 40).map(line).join("\n") || "- нет"}\n\n`;
  md += `## Упомянуты один раз: стоит подкрепить в опыте\n\n${thin.slice(0, 25).map(line).join("\n") || "- нет"}\n\n`;
  md += `## Есть в тексте резюме, но не в поле «Ключевые навыки» (кандидаты в теги hh)\n\n${notInField.slice(0, 25).map(line).join("\n") || "- нет"}\n\n`;
  md += `## Лучшие совпадения\n\n${per.slice(0, 15).map((p) => `- ${p.score}: ${p.v.title}, ${p.v.company}${p.v.url ? " " + p.v.url : ""}${p.missing.length ? ` (нет: ${p.missing.slice(0, 6).map(d).join(", ")})` : ""}`).join("\n")}\n\n`;
  md += `## Слабые совпадения\n\n${per.slice(-10).reverse().map((p) => `- ${p.score}: ${p.v.title}, ${p.v.company}${p.missing.length ? ` (нет: ${p.missing.slice(0, 6).map(d).join(", ")})` : ""}`).join("\n")}\n\n`;
  md += "> Только диагностика. Навык добавляется в резюме, если он правда есть в вашем опыте: формулировка своя, ничего не выдумывается.\n";
  const base = join(OUT, "ats", `${r.name}.${sample}`);
  writeFileSync(base + ".md", md);
  writeFileSync(base + ".json", JSON.stringify({ resume: r.name, sample, vacancies: per.length, median, good, fieldMatch: field, missing: missing.map(([k, n]) => ({ skill: d(k), vacancies: n })), thin: thin.map(([k, n]) => ({ skill: d(k), vacancies: n })), notInField: notInField.map(([k, n]) => ({ skill: d(k), vacancies: n })), top: per.slice(0, 30).map((p) => ({ score: p.score, title: p.v.title, company: p.v.company, url: p.v.url, missing: p.missing.map(d) })) }, null, 1));
  console.log(`ats: ${r.name} × ${sample}: вакансий ${per.length}, медиана ${median}, 70+ у ${pct(good)}%, поле навыков совпадает на ${field}% → ${fwd(base + ".md")}`);
  console.log("  нет в резюме: " + missing.slice(0, 12).map(([k, n]) => `${d(k)} ${pct(n)}%`).join(", "));
}
