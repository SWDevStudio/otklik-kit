#!/usr/bin/env bun
// ATS-сверка резюме с вакансиями: какая доля ключевых навыков вакансии есть в резюме.
// Методика покрытия (найдено / всего, поиск по границам слов, группы синонимов, «упомянуто один раз»)
// взята из keyword-match.mjs проекта career-ops: https://github.com/career-ops-hq/career-ops
// (MIT License, Copyright (c) 2026 Santiago Fernández de Valderrama). Доработано: Unicode-границы слов,
// русские леммы (pymorphy3), навыки из текста вакансии, пакетный прогон по выборке.
//
//   bun messages/scripts/ats.mjs --jobs messages/out/market/front.jsonl --resume react --resume vue
//   bun messages/scripts/ats.mjs --jobs messages/out/market/lead.jsonl --resume lead --where "frontend|react|vue"
//   --resume   ключ резюме (messages/resumes/<ключ>.md) или путь к любому .md/.txt
//   --where    регулярное выражение по названию и тегам вакансии (текст не учитывается: там часто «взаимодействие с frontend»)
//   --min-tag  тег считается словарным навыком, если встречается хотя бы в N вакансиях выборки (по умолчанию 3)
// Отчёт: messages/out/ats/<резюме>.<выборка>.md и .json. Только диагностика: навык добавляется в резюме,
// если он правда есть в опыте, формулируется своими словами и не выдумывается.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT, CONFIG, fwd, read, findPython } from "./lib.mjs";
import { loadResumes, RESUMES_DIR } from "./hh/spec.mjs";

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

// ---------- тексты ----------
const nf = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const spec = loadResumes(opt("--dir") || RESUMES_DIR);
const resumes = resumeArgs.map((a) => {
  if (spec.resumes[a]) {
    const r = spec.resumes[a];
    const jobs = spec.jobs.filter((j) => j.texts[a]).map((j) => `${j.position}\n${j.texts[a]}`);
    return { name: a, skills: r.skills || [], text: [r.title, (r.skills || []).join(", "), r.about, ...jobs].filter(Boolean).join("\n\n") };
  }
  if (!existsSync(a)) {
    console.log(`ats: нет резюме «${a}»: ни messages/resumes/${a}.md, ни такого файла`);
    process.exit(1);
  }
  const text = read(a);
  const m = text.match(/##\s*Навыки\s*\n([\s\S]*?)(\n##\s|$)/);
  const skills = m ? m[1].split(/[,\n]/).map((s) => s.replace(/\*\*[^*]*\*\*:?/g, "").replace(/^[-*]\s*/, "").trim()).filter((s) => s && s.length < 40) : [];
  return { name: basename(a, extname(a)), skills, text };
});
const where = opt("--where") ? new RegExp(opt("--where"), "iu") : null;
const vacancies = read(jobsFile).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((v) => !where || where.test(v.title + " " + (v.key_skills || []).join(" ")));
if (!vacancies.length) {
  console.log("ats: в выборке нет вакансий" + (where ? " под --where" : ""));
  process.exit(1);
}

// ---------- синонимы и словарь ----------
let groups = [];
try {
  groups = JSON.parse(read(join(CONFIG, "ats-synonyms.json"))).groups.map((g) => g.map(nf));
} catch {}
const groupOf = (k) => groups.find((g) => g.includes(nf(k))) || [nf(k)];
const tagCount = new Map();
const spelling = new Map();
for (const v of vacancies) for (const t of new Set((v.key_skills || []).map((s) => groupOf(s)[0]))) tagCount.set(t, (tagCount.get(t) || 0) + 1);
for (const v of vacancies) for (const s of v.key_skills || []) { const k = groupOf(s)[0]; const e = spelling.get(k) || {}; e[s] = (e[s] || 0) + 1; spelling.set(k, e); }
const display = (k) => Object.entries(spelling.get(k) || { [k]: 1 }).sort((a, b) => b[1] - a[1])[0][0];
const dictionary = [...tagCount].filter(([, c]) => c >= minTag).map(([k]) => k);

// ---------- леммы одним вызовом python ----------
const forms = new Set();
for (const k of tagCount.keys()) for (const f of groupOf(k)) forms.add(f);
const texts = [...resumes.map((r) => r.text), ...vacancies.map((v) => v.text || "")];
const py = findPython();
let lem = (s) => nf(s);
if (py) {
  const input = [...forms, ...texts];
  const here = dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(py, [join(here, "lemmas.py")], { input: Buffer.from(JSON.stringify(input), "utf8"), maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true });
  if (r.status === 0) {
    const out = JSON.parse(r.stdout.toString("utf8"));
    const map = new Map(input.map((s, i) => [s, nf(out[i])]));
    lem = (s) => map.get(s) ?? nf(s);
  } else console.log("ats: леммы не посчитались, сравниваю без них: " + String(r.stderr).slice(0, 200));
} else console.log("ats: нет python с razdel и pymorphy3, русские формы слов сравниваются без лемм");

// ---------- поиск навыка в тексте ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reCache = new Map();
function count(term, hay) {
  if (!term) return 0;
  let re = reCache.get(term);
  if (!re) reCache.set(term, (re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?![\\p{L}\\p{N}])`, "gu")));
  return (hay.match(re) || []).length;
}
function occurrences(key, raw, lemmaText) {
  let n = 0;
  for (const f of groupOf(key)) n = Math.max(n, count(f, raw), count(lem(f), lemmaText));
  return n;
}

// ---------- оценка ----------
const vacLem = new Map(vacancies.map((v) => [v, lem(v.text || "")]));
const vacRaw = new Map(vacancies.map((v) => [v, nf(v.text || "")]));
mkdirSync(join(OUT, "ats"), { recursive: true });
const sample = basename(jobsFile, extname(jobsFile)) + (where ? "-" + opt("--where").replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 20) : "");
for (const r of resumes) {
  const raw = nf(r.text);
  const lemma = lem(r.text);
  const inResume = new Map();
  const has = (k) => {
    if (!inResume.has(k)) inResume.set(k, occurrences(k, raw, lemma));
    return inResume.get(k);
  };
  const skillField = new Set(r.skills.map((s) => groupOf(s)[0]));
  const per = [];
  for (const v of vacancies) {
    const tags = [...new Set((v.key_skills || []).map((s) => groupOf(s)[0]))];
    const fromText = dictionary.filter((k) => !tags.includes(k) && occurrences(k, vacRaw.get(v), vacLem.get(v)) > 0);
    const tagHit = tags.filter((k) => has(k) > 0);
    const textHit = fromText.filter((k) => has(k) > 0);
    const tagCov = tags.length ? tagHit.length / tags.length : null;
    const textCov = fromText.length ? textHit.length / fromText.length : null;
    const score = Math.round(100 * (tagCov === null ? textCov ?? 0 : textCov === null ? tagCov : 0.7 * tagCov + 0.3 * textCov));
    const fieldHit = tags.length ? tags.filter((k) => skillField.has(k)).length / tags.length : null;
    per.push({ v, score, tags, fromText, fieldHit, missing: [...tags, ...fromText].filter((k) => has(k) === 0) });
  }
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
  const missing = ranked.filter(([k]) => has(k) === 0);
  const thin = ranked.filter(([k]) => has(k) === 1);
  const notInField = ranked.filter(([k]) => has(k) > 0 && !skillField.has(k) && tagCount.has(k));
  const line = ([k, n]) => `- ${display(k)}: ${n} (${pct(n)}%)`;
  let md = `# ATS: ${r.name} против ${sample}\n\nВакансий ${per.length}. Оценка вакансии: 0,7 × доля её тегов hh, найденных в резюме, + 0,3 × доля словарных навыков из её текста (словарь: теги, встречающиеся в ${minTag}+ вакансиях выборки).\n\n`;
  md += `- Медиана оценки: **${median}**; вакансий с оценкой 70+: ${good} (${pct(good)}%)\n`;
  md += `- Совпадение поля «Ключевые навыки» резюме с тегами вакансий: в среднем ${field}%${r.skills.length ? ` (в резюме ${r.skills.length} навыков)` : " (поле навыков не найдено)"}\n\n`;
  md += `## Нет в резюме, но нужны вакансиям (доля вакансий)\n\n${missing.slice(0, 40).map(line).join("\n") || "- нет"}\n\n`;
  md += `## Упомянуты один раз: стоит подкрепить в опыте\n\n${thin.slice(0, 25).map(line).join("\n") || "- нет"}\n\n`;
  md += `## Есть в тексте резюме, но не в поле «Ключевые навыки» (кандидаты в теги hh)\n\n${notInField.slice(0, 25).map(line).join("\n") || "- нет"}\n\n`;
  md += `## Лучшие совпадения\n\n${per.slice(0, 15).map((p) => `- ${p.score}: ${p.v.title}, ${p.v.company}${p.v.url ? " " + p.v.url : ""}${p.missing.length ? ` (нет: ${p.missing.slice(0, 6).map(display).join(", ")})` : ""}`).join("\n")}\n\n`;
  md += `## Слабые совпадения\n\n${per.slice(-10).reverse().map((p) => `- ${p.score}: ${p.v.title}, ${p.v.company}${p.missing.length ? ` (нет: ${p.missing.slice(0, 6).map(display).join(", ")})` : ""}`).join("\n")}\n\n`;
  md += "> Только диагностика. Навык добавляется в резюме, если он правда есть в вашем опыте: формулировка своя, ничего не выдумывается.\n";
  const base = join(OUT, "ats", `${r.name}.${sample}`);
  writeFileSync(base + ".md", md);
  writeFileSync(base + ".json", JSON.stringify({ resume: r.name, sample, vacancies: per.length, median, good, fieldMatch: field, missing: missing.map(([k, n]) => ({ skill: display(k), vacancies: n })), thin: thin.map(([k, n]) => ({ skill: display(k), vacancies: n })), notInField: notInField.map(([k, n]) => ({ skill: display(k), vacancies: n })), top: per.slice(0, 30).map((p) => ({ score: p.score, title: p.v.title, company: p.v.company, url: p.v.url, missing: p.missing.map(display) })) }, null, 1));
  console.log(`ats: ${r.name} × ${sample}: вакансий ${per.length}, медиана ${median}, 70+ у ${pct(good)}%, поле навыков совпадает на ${field}% → ${fwd(base + ".md")}`);
  console.log("  нет в резюме: " + missing.slice(0, 12).map(([k, n]) => `${display(k)} ${pct(n)}%`).join(", "));
}
