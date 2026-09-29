// ATS-сверка резюме с вакансиями: общая часть для ats.mjs, search.mjs и fetch.mjs.
// Методика покрытия (найдено / всего, поиск по границам слов, группы синонимов) взята из keyword-match.mjs
// проекта career-ops: https://github.com/career-ops-hq/career-ops (MIT License, Copyright (c) 2026
// Santiago Fernández de Valderrama). Доработано: Unicode-границы слов, русские леммы (pymorphy3),
// навыки из текста вакансии по словарю тегов, сверка с несколькими резюме сразу.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT, CONFIG, RESUME, read, findPython } from "./lib.mjs";
import { loadResumes, RESUMES_DIR } from "./hh/spec.mjs";

export const nf = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const HERE = dirname(fileURLToPath(import.meta.url));

export function skillsFromMd(text) {
  const m = text.match(/##\s*Навыки\s*\n([\s\S]*?)(\n##\s|$)/);
  return m ? m[1].split(/[,\n]/).map((s) => s.replace(/\*\*[^*]*\*\*:?/g, "").replace(/^[-*]\s*/, "").trim()).filter((s) => s && s.length < 40) : [];
}

// Резюме для сверки: messages/resumes/*.md, а если их нет, messages/resume-public.md.
export function atsResumes(dir = RESUMES_DIR) {
  const spec = loadResumes(dir);
  const list = Object.entries(spec.resumes).map(([k, r]) => ({
    name: k,
    title: r.title,
    pdf: r.pdf,
    lead: r.market === "lead",
    market: r.market,
    where: r.where,
    salary: r.salary,
    currency: r.currency,
    skills: r.skills || [],
    text: [r.title, (r.skills || []).join(", "), r.about, ...spec.jobs.filter((j) => j.texts[k]).map((j) => `${j.position}\n${j.texts[k]}`)].filter(Boolean).join("\n\n"),
  }));
  if (list.length) return list;
  const txt = read(RESUME);
  return txt.trim() ? [{ name: "resume", skills: skillsFromMd(txt), text: txt }] : [];
}

// Вакансии всех срезов рынка (messages/out/market/*.jsonl): по ним строится словарь навыков.
export function marketCorpus() {
  const dir = join(OUT, "market");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => read(join(dir, f)).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
}

export function prepare({ resumes, vacancies, corpus = [], minTag = 3 }) {
  let groups = [];
  try {
    groups = JSON.parse(read(join(CONFIG, "ats-synonyms.json"))).groups.map((g) => g.map(nf));
  } catch {}
  const groupOf = (k) => groups.find((g) => g.includes(nf(k))) || [nf(k)];
  const tagCount = new Map();
  const spelling = new Map();
  const seen = new Set();
  for (const v of [...corpus, ...vacancies]) {
    const id = v.id || v.url || v.title + "|" + v.company;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const t of new Set((v.key_skills || []).map((s) => groupOf(s)[0]))) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    for (const s of v.key_skills || []) {
      const k = groupOf(s)[0];
      const e = spelling.get(k) || {};
      e[s] = (e[s] || 0) + 1;
      spelling.set(k, e);
    }
  }
  const display = (k) => Object.entries(spelling.get(k) || { [k]: 1 }).sort((a, b) => b[1] - a[1])[0][0];
  const dictionary = [...tagCount].filter(([, c]) => c >= minTag).map(([k]) => k);

  // леммы одним вызовом python
  const forms = new Set();
  for (const k of tagCount.keys()) for (const f of groupOf(k)) forms.add(f);
  const input = [...forms, ...resumes.map((r) => r.text), ...vacancies.map((v) => v.text || "")];
  let lem = (s) => nf(s);
  let lemmas = false;
  const py = findPython();
  if (py && input.length) {
    const r = spawnSync(py, [join(HERE, "lemmas.py")], { input: Buffer.from(JSON.stringify(input), "utf8"), maxBuffer: 512 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true });
    if (r.status === 0) {
      const out = JSON.parse(r.stdout.toString("utf8"));
      const map = new Map(input.map((s, i) => [s, nf(out[i])]));
      lem = (s) => map.get(s) ?? nf(s);
      lemmas = true;
    }
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reCache = new Map();
  const count = (term, hay) => {
    if (!term) return 0;
    let re = reCache.get(term);
    if (!re) reCache.set(term, (re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?![\\p{L}\\p{N}])`, "gu")));
    return (hay.match(re) || []).length;
  };
  const occurrences = (key, raw, lemmaText) => {
    let n = 0;
    for (const f of groupOf(key)) n = Math.max(n, count(f, raw), count(lem(f), lemmaText));
    return n;
  };
  const rCache = new Map();
  const has = (r, k) => {
    let c = rCache.get(r);
    if (!c) rCache.set(r, (c = { raw: nf(r.text), lemma: lem(r.text), hits: new Map() }));
    if (!c.hits.has(k)) c.hits.set(k, occurrences(k, c.raw, c.lemma));
    return c.hits.get(k);
  };
  const vCache = new Map();
  const vacTerms = (v) => {
    if (!vCache.has(v)) {
      const tags = [...new Set((v.key_skills || []).map((s) => groupOf(s)[0]))];
      const raw = nf(v.text || "");
      const lemma = lem(v.text || "");
      vCache.set(v, { tags, fromText: dictionary.filter((k) => !tags.includes(k) && occurrences(k, raw, lemma) > 0) });
    }
    return vCache.get(v);
  };
  // Оценка: 0,7 × доля тегов вакансии, найденных в резюме, + 0,3 × доля словарных навыков из её текста.
  const score = (r, v) => {
    const { tags, fromText } = vacTerms(v);
    const tagCov = tags.length ? tags.filter((k) => has(r, k) > 0).length / tags.length : null;
    const textCov = fromText.length ? fromText.filter((k) => has(r, k) > 0).length / fromText.length : null;
    const value = tagCov === null && textCov === null ? null : Math.round(100 * (tagCov === null ? textCov : textCov === null ? tagCov : 0.7 * tagCov + 0.3 * textCov));
    const field = new Set(r.skills.map((s) => groupOf(s)[0]));
    return { score: value, tags, fromText, fieldHit: tags.length ? tags.filter((k) => field.has(k)).length / tags.length : null, missing: [...tags, ...fromText].filter((k) => has(r, k) === 0) };
  };
  // Лучшее резюме для вакансии. На нелидскую вакансию лидское резюме (market: lead) не предлагается, если есть другие.
  const best = (v, { lead = true } = {}) => {
    const pool = lead || !resumes.some((r) => !r.lead) ? resumes : resumes.filter((r) => !r.lead);
    let top = null;
    for (const r of pool) {
      const s = score(r, v);
      if (s.score !== null && (!top || s.score > top.score)) top = { resume: r, ...s };
    }
    return top;
  };
  return { groupOf, display, tagCount, dictionary, lemmas, has, score, best };
}
