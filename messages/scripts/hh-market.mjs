#!/usr/bin/env bun
// Срез рынка hh.ru: вакансии по названию, частоты ключевых навыков (тегов hh) и названий.
//   bun messages/scripts/hh-market.mjs                  фронтенд: запросы и фильтры названий из config/search.json
//   bun messages/scripts/hh-market.mjs --lead           лидские вакансии разработки на любом стеке
//   --query "a" --query "b"   свои запросы вместо конфига
//   --segments "react=react|next\.?js;vue=vue|nuxt"     подсегменты по тексту вакансии
//   --name <имя>              имя выборки (по умолчанию front или lead)
// Результат: messages/out/market/<имя>.jsonl (вакансии для ats.mjs) и <имя>.md (частоты).
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OUT, CONFIG, fwd, read } from "./lib.mjs";
import { PARSERS, kit, classify, extract, blockedHosts } from "./extract.mjs";

const argv = process.argv.slice(2);
const all = (f) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]] : []));
const opt = (f) => all(f)[0] || "";
const LEAD = argv.includes("--lead");
const name = opt("--name") || (LEAD ? "lead" : "front");
const dir = join(OUT, "market");
mkdirSync(dir, { recursive: true });

const W = "(?<![\\p{L}\\p{N}])", WE = "(?![\\p{L}\\p{N}])";
const rx = (s) => new RegExp(String(s).replace(/<w>/g, W).replace(/<\/w>/g, WE), "iu");
let cfg = {};
try {
  cfg = JSON.parse(read(join(CONFIG, "search.json")) || "{}");
} catch {}

const LEAD_QUERIES = ["team lead", "teamlead", "тимлид", "тимлид разработки", "tech lead", "техлид", "lead developer", "lead engineer", "руководитель группы разработки", "руководитель отдела разработки", "руководитель разработки", "руководитель команды разработки", "head of development", "engineering manager", "frontend team lead", "руководитель frontend"];
const queries = all("--query").length ? all("--query") : LEAD ? LEAD_QUERIES : cfg.queries || [];
if (!queries.length) {
  console.log("hh-market: нет запросов: передайте --query или заполните queries в messages/config/search.json");
  process.exit(1);
}
const titleOk = LEAD ? /lead|лид(?!\p{L}*ер)|руковод|head|тимлид|техлид|engineering\s+manager|principal|staff/iu : cfg.title_ok ? rx(cfg.title_ok) : /./;
const titleDev = LEAD ? /разработ|develop|engineer|инженер|программ|frontend|front-end|фронт|backend|бэкенд|web|веб|js|typescript|react|vue|node|java|python|golang|php|mobile|ios|android|\.net|c#|kotlin/iu : /./;
const titleBad = LEAD ? /qa|тестиров|аналит|analyst|дизайн|design|маркетолог|маркетинг|marketing|продаж|sales|1[сc]|битрикс|bitrix|product\s+(manager|owner)|project\s+manager|менеджер|hr|рекрут|recruit|поддержк|support|devops|sre|безопасн|security|data|данных|бухгалт|юрист|склад|логист|монтаж|электр|механ|строит|производ|сметч|проектировщ/iu : cfg.title_bad ? rx(cfg.title_bad) : /$^/;
const level = (t) => (/lead|лид(?!\p{L}*ер)|руковод|head|тимлид|техлид/iu.test(t) ? "lead" : /senior|сеньор|синьор|ведущ|старш/iu.test(t) ? "senior" : /middle|мидл/iu.test(t) ? "middle" : "-");

const hh = PARSERS.find((p) => p.name === "hh");
const cards = new Map();
for (const q of queries) {
  try {
    const { cards: list, total } = await hh.search(q, { remoteOnly: false, maxPages: 20 }, kit);
    for (const c of list) if (!cards.has(c.id)) cards.set(c.id, c);
    console.log(`поиск «${q}»: в выдаче ${total}, карточек всего ${cards.size}`);
  } catch (e) {
    console.log(`поиск «${q}»: ${e.message}`);
  }
}
const twins = new Set();
const picked = [...cards.values()].filter((c) => {
  if (c.closed || c.exp === "none" || !titleOk.test(c.title) || !titleDev.test(c.title) || titleBad.test(c.title)) return false;
  const key = (c.title + "|" + c.company).toLowerCase().replace(/\s+/g, " ");
  if (twins.has(key)) return false;
  twins.add(key);
  return true;
});
console.log(`по названию отобрано ${picked.length} из ${cards.size}; загружаю вакансии (страницы из кэша берутся сразу)`);

const rows = [];
let n = 0;
for (const c of picked) {
  n++;
  try {
    const v = await extract(classify(c.url));
    if (!v.archived) rows.push({ id: c.id, url: c.url, title: v.title || c.title, company: v.company || c.company, level: level(c.title), exp: c.exp, salary: v.salary || "", key_skills: v.key_skills || [], text: v.text || "" });
  } catch (e) {
    console.log(`ошибка ${c.url}: ${e.message}`);
    if (blockedHosts.size) {
      console.log("hh отказал; повторный запуск продолжит, скачанные страницы уже в кэше");
      break;
    }
  }
  if (n % 50 === 0) console.log(`загружено ${n}/${picked.length}`);
}
writeFileSync(join(dir, name + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// Частоты тегов и названий
const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
function tagStats(list) {
  const m = new Map();
  for (const v of list) for (const s of new Set(v.key_skills.map(norm))) m.set(s, (m.get(s) || 0) + 1);
  const spell = new Map();
  for (const v of list) for (const s of v.key_skills) { const k = norm(s); const e = spell.get(k) || {}; e[s] = (e[s] || 0) + 1; spell.set(k, e); }
  return [...m].map(([k, cnt]) => ({ tag: Object.entries(spell.get(k)).sort((a, b) => b[1] - a[1])[0][0], cnt })).sort((a, b) => b.cnt - a.cnt);
}
const titleNorm = (t) => t.replace(/\s*[,(].*$/, "").replace(/\s+/g, " ").trim();
function titleStats(list) {
  const m = new Map();
  for (const v of list) { const t = titleNorm(v.title); m.set(t, (m.get(t) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
}
const segs = [["все", () => true]];
for (const part of (opt("--segments") || (LEAD ? "" : "react=react(?!\\s*native)|next\\.?js;vue=vue|nuxt")).split(";").filter(Boolean)) {
  const [k, re] = part.split("=");
  const r = new RegExp(re, "iu");
  segs.push([k, (v) => r.test(v.title + " " + v.key_skills.join(" ") + " " + v.text)]);
}
if (LEAD) segs.push(["фронтенд-лиды", (v) => /frontend|front-end|фронтенд|react|vue|angular|javascript|typescript/iu.test(v.title + " " + v.key_skills.join(" "))]);
let md = `# Срез рынка hh: ${name}\n\nЗапросы: ${queries.join(", ")}. Вакансий: ${rows.length}, с тегами: ${rows.filter((r) => r.key_skills.length).length}.\n`;
for (const [k, f] of segs) {
  const list = rows.filter(f);
  const withTags = list.filter((r) => r.key_skills.length).length || 1;
  md += `\n## ${k}: ${list.length} вакансий\n\n### Ключевые навыки (доля вакансий с тегами)\n\n` + tagStats(list).slice(0, 60).map((t) => `- ${t.tag}: ${t.cnt} (${Math.round((100 * t.cnt) / withTags)}%)`).join("\n") + "\n";
  md += `\n### Названия (без уточнений в скобках)\n\n` + titleStats(list).slice(0, 20).map(([t, c]) => `- ${t}: ${c}`).join("\n") + "\n";
}
writeFileSync(join(dir, name + ".md"), md);
console.log(`hh-market: вакансий ${rows.length} → ${fwd(join(dir, name + ".jsonl"))}, частоты → ${fwd(join(dir, name + ".md"))}`);
