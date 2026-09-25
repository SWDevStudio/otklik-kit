#!/usr/bin/env bun
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { JOBS, CONFIG, fwd, read, today, parseDoc, formatDoc, statusLine, jobFile } from "./lib.mjs";
import { settings, kit, PARSERS, parserErrors, classify, extract, blockedHosts } from "./extract.mjs";

const CONFIG_FILE = join(CONFIG, "search.json");
const cli = { queries: [], sources: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--query") cli.queries.push(argv[++i]);
  else if (a === "--source") cli.sources.push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
  else if (a === "--min-score") cli.minScore = +argv[++i];
  else if (a === "--limit") cli.limit = +argv[++i];
  else if (a === "--fetch-top") cli.fetchTop = +argv[++i];
  else if (a === "--min-salary") cli.minSalary = +argv[++i];
  else if (a === "--any-format") cli.anyFormat = true;
  else if (a === "--refetch") settings.refetch = true;
  else if (a === "--check-config") cli.check = true;
}

let cfg;
try {
  cfg = JSON.parse(read(CONFIG_FILE));
} catch (e) {
  console.log(`search: нет или не читается ${fwd(CONFIG_FILE)} (${existsSync(CONFIG_FILE) ? e.message : "файла нет"}): запустите /otklik --refresh-profile или скопируйте config/search.example.json в config/search.json`);
  process.exit(1);
}

const W = "(?<![\\p{L}\\p{N}])";
const WE = "(?![\\p{L}\\p{N}])";
const bad = [];
const rx = (s, where) => {
  try {
    return new RegExp(String(s).replace(/<w>/g, W).replace(/<\/w>/g, WE), "iu");
  } catch (e) {
    bad.push(`${where}: ${e.message}`);
    return /$^/;
  }
};
const C = {
  queries: cli.queries.length ? cli.queries : cfg.queries || [],
  remoteOnly: cli.anyFormat ? false : cfg.remote_only !== false,
  minSalary: cli.minSalary ?? cfg.min_salary ?? 0,
  minScore: cli.minScore ?? cfg.min_score ?? 10,
  limit: cli.limit ?? cfg.limit ?? 30,
  fetchTop: cli.fetchTop ?? cfg.fetch_top ?? 80,
  maxPages: cfg.max_pages ?? 20,
  skipNoExp: cfg.skip_no_experience !== false,
  titleOk: cfg.title_ok ? rx(cfg.title_ok, "title_ok") : null,
  titleBad: cfg.title_bad ? rx(cfg.title_bad, "title_bad") : null,
  levels: Object.entries(cfg.levels || {}).map(([name, l]) => ({ name, re: rx(l.re, `levels.${name}`), w: +l.w || 0 })),
  preferExp: cfg.prefer_experience || [],
  expBonus: cfg.experience_bonus ?? 2,
  titleTerms: (cfg.title_terms || []).map(([re, w], i) => ({ re: rx(re, `title_terms[${i}]`), w: +w || 0 })),
  titleMinus: (cfg.title_minus || []).map((m, i) => ({ name: m.name, re: rx(m.re, `title_minus[${i}]`), w: +m.w || 0 })),
  terms: (cfg.terms || []).map(([name, re, w], i) => ({ name, re: rx(re, `terms[${i}]`), w: +w || 0 })),
  minus: (cfg.minus || []).map((m, i) => ({ name: m.name, re: rx(m.re, `minus[${i}]`), and: m.and ? rx(m.and, `minus[${i}].and`) : null, unless: m.unless ? rx(m.unless, `minus[${i}].unless`) : null, w: +m.w || 0 })),
  bonuses: (cfg.bonuses || []).map((b) => ({ level: b.level, term: b.term, w: +b.w || 0 })),
  manyResponses: cfg.many_responses ?? 0,
};
if (!C.queries.length) bad.push("queries: пустой список запросов");
if (cli.check || bad.length) {
  console.log(bad.length ? "config: ошибки\n" + bad.map((b) => "- " + b).join("\n") : `config ok | запросов ${C.queries.length} | терминов ${C.terms.length} | минусов ${C.minus.length} | уровней ${C.levels.length}`);
  process.exit(bad.length ? 1 : 0);
}

let sources = PARSERS.filter((p) => p.search);
if (cli.sources.length) {
  const missing = cli.sources.filter((n) => !PARSERS.some((p) => p.name === n));
  const noSearch = cli.sources.filter((n) => PARSERS.some((p) => p.name === n && !p.search));
  if (missing.length || noSearch.length) {
    console.log(statusLine());
    for (const n of missing) console.log(`search: парсера ${n} нет: нужен парсер с поиском: ${n}`);
    for (const n of noSearch) console.log(`search: у парсера ${n} нет поиска: нужен парсер с поиском: ${n}`);
    process.exit(2);
  }
  sources = PARSERS.filter((p) => cli.sources.includes(p.name));
}
if (!sources.length) {
  console.log("search: ни у одного парсера нет поиска: нужен парсер с поиском");
  process.exit(2);
}
mkdirSync(JOBS, { recursive: true });

const OFFICE_ONLY = rx(`только\\s+(в\\s+)?офис|офисн\\p{L}*\\s+формат|формат\\p{L}*\\s+работы\\s*:?\\s*(офис|гибрид)|работа\\s+(только\\s+)?в\\s+офисе|гибридн\\p{L}*\\s+формат|on-?site\\s+only|office\\s+only`, "office");
const REMOTE_WORD = rx(`удал[её]нн|удал[её]нк|удал[её]нно|remote|дистанционн`, "remote");
const LOCAL_ONLY = rx(`местн|жител|проживающ|для\\s+сотрудников\\s+из|из\\s+(г\\.|город)|в\\s+пределах\\s+город|релокац`, "local");

const level = (title) => C.levels.find((l) => l.re.test(title))?.name || "-";
const levelW = (lv) => C.levels.find((l) => l.name === lv)?.w || 0;
const expW = (c) => (C.preferExp.includes(c.exp) ? C.expBonus : 0);

function preScore(c) {
  return levelW(level(c.title)) + C.titleTerms.filter((t) => t.re.test(c.title)).reduce((a, t) => a + t.w, 0) + expW(c);
}

function fullScore(c, v) {
  const text = [v.title, (v.key_skills || []).join(", "), v.text].join("\n");
  const hits = C.terms.filter((t) => t.re.test(text));
  const lv = level(c.title);
  let s = hits.reduce((a, t) => a + t.w, 0) + levelW(lv) + expW(c);
  for (const b of C.bonuses) if (b.level === lv && hits.some((h) => h.name === b.term)) s += b.w;
  const minus = C.minus.filter((m) => m.re.test(text) && (!m.and || m.and.test(text)) && !(m.unless && m.unless.test(text))).map((m) => [m.name, m.w]);
  for (const m of C.titleMinus) if (m.re.test(c.title)) minus.push([m.name, m.w]);
  s += minus.reduce((a, [, w]) => a + w, 0);
  if (C.manyResponses && +c.responses > C.manyResponses) s -= 1;
  return { score: s, level: lv, hits: hits.map((h) => h.name), minus: minus.map(([n]) => n) };
}

const cards = new Map();
let total = 0;
for (const p of sources) {
  for (const q of C.queries) {
    let res;
    try {
      res = await p.search(q, { remoteOnly: C.remoteOnly, maxPages: C.maxPages }, kit);
    } catch (e) {
      console.log(`warn | ${p.name}: поиск «${q}»: ${e.message}`);
      continue;
    }
    const list = Array.isArray(res) ? res : res?.cards || [];
    total += (Array.isArray(res) ? 0 : res?.total) || list.length;
    for (const c of list) {
      if (!c?.id || !c.url) continue;
      const key = `${p.name}:${c.id}`;
      if (!cards.has(key)) cards.set(key, { ...c, title: c.title || "", source: p.name });
    }
  }
}

const twins = new Set();
let lowPay = 0;
let notRemote = 0;
const passed = [...cards.values()].filter((c) => {
  if (c.closed || (C.skipNoExp && c.exp === "none")) return false;
  if (C.titleOk && !C.titleOk.test(c.title)) return false;
  if (C.titleBad && C.titleBad.test(c.title)) return false;
  if (C.remoteOnly && c.remote === false) {
    notRemote++;
    return false;
  }
  if (C.minSalary && c.topRub !== null && c.topRub !== undefined && c.topRub <= C.minSalary) {
    lowPay++;
    return false;
  }
  const key = (c.title + "|" + (c.company || "")).toLowerCase().replace(/\s+/g, " ");
  if (twins.has(key)) return false;
  twins.add(key);
  return true;
});
const ranked = passed.map((c) => ({ ...c, pre: preScore(c) })).sort((a, b) => b.pre - a.pre).slice(0, C.fetchTop);

const scored = [];
let failed = 0;
for (const c of ranked) {
  const s = classify(c.url);
  if (s.host && blockedHosts.has(new URL(s.url || c.url).hostname)) continue;
  try {
    const v = await extract(s);
    if (v.archived) continue;
    const office = String(v.text || "").split(/(?<=[.!?])\s+|\n+/).filter((x) => OFFICE_ONLY.test(x) && !LOCAL_ONLY.test(x));
    if (C.remoteOnly && office.length && !REMOTE_WORD.test(v.text)) {
      notRemote++;
      continue;
    }
    const slug = v.original_slug || s.slug;
    if (scored.some((x) => x.slug === slug)) continue;
    scored.push({ ...c, slug, url: v.original || c.url, found_via: v.found_via, v, ...fullScore(c, v) });
  } catch (e) {
    failed++;
    if (e.brokenParser) console.log(`warn | ${e.message}: нужен ремонт парсера: ${e.brokenParser} (${s.host})`);
  }
}
const RANK = Object.fromEntries(C.levels.map((l, i) => [l.name, i]));
scored.sort((a, b) => b.score - a.score || (RANK[a.level] ?? 99) - (RANK[b.level] ?? 99));
const picked = scored.filter((x) => x.score >= C.minScore).slice(0, C.limit);

console.log(statusLine());
for (const e of parserErrors) console.log("warn | парсер не загрузился: " + e);
console.log(
  `search: площадки ${sources.map((p) => p.name).join(", ")} | в выдаче ${total} (без дублей ${cards.size}) | зарплата «до» не выше ${C.minSalary}: пропущено ${lowPay} | без удалёнки: пропущено ${notRemote} | после отсева ${passed.length} | загружено ${scored.length}${failed ? `, ошибок ${failed}` : ""} | порог ${C.minScore}: подходят ${scored.filter((x) => x.score >= C.minScore).length}, в jobs ${picked.length}`
);
for (const x of picked) {
  const file = jobFile(x.slug);
  const exists = existsSync(file);
  const prev = exists ? parseDoc(read(file)).head : {};
  if (!exists) {
    const head = { url: x.url, title: x.v.title || x.title, company: x.v.company || x.company, salary: x.v.salary || x.salary, experience: x.v.experience || x.experience, level: x.level, score: x.score, source: x.found_via || x.source, found: today(), status: "new" };
    const why = [x.hits.join(", "), x.minus.length ? "минус: " + x.minus.join(", ") : ""].filter(Boolean).join("; ");
    const lines = [
      `# ${head.title}${head.company ? ", " + head.company : ""}`,
      "",
      `Ссылка: ${head.url}`,
      `Совпадение: ${x.score} (${why}; уровень ${x.level})`,
      `Зарплата: ${head.salary || "не указана"}`,
      `Опыт: ${head.experience || "-"}${x.responses !== "" && x.responses !== undefined ? ` | откликов: ${x.responses}` : ""}${x.letter ? " | письмо обязательно" : ""}${x.test ? " | есть тест" : ""}`,
    ];
    writeFileSync(file, formatDoc(head, lines.join("\n")));
  }
  console.log([exists ? (prev.status === "letter" ? "done" : "have") : "new ", x.score, fwd(file), x.v.title || x.title, x.v.company || x.company || "-", x.v.salary || x.salary || "-", x.level].join(" | "));
}
