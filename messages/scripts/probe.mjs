#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { fwd } from "./lib.mjs";
import { settings, kit, PARSERS, parserErrors, classify, extract, cacheFile, quality, ldJobPosting, jsonBlobs, htmlText, meta, mainText } from "./extract.mjs";

const argv = process.argv.slice(2);
const opt = { url: "" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--parser") opt.parser = argv[++i];
  else if (a === "--search") opt.search = argv[++i];
  else if (a === "--query") opt.query = argv[++i];
  else if (a === "--blob") opt.blob = +argv[++i];
  else if (a === "--path") opt.path = argv[++i];
  else if (a === "--grep") opt.grep = argv[++i];
  else if (a === "--list") opt.list = true;
  else if (a === "--browser") settings.browser = true;
  else if (a === "--refetch") settings.refetch = true;
  else if (!a.startsWith("--")) opt.url = a;
}
const cut = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
for (const e of parserErrors) console.log("warn | парсер не загрузился: " + e);

if (opt.list) {
  for (const p of PARSERS) console.log([p.name.padEnd(12), p.channel.padEnd(11), p.search ? "поиск есть" : "поиска нет", p.hosts.join(", ") || "-"].join(" | "));
  if (!PARSERS.length) console.log("парсеров нет");
  process.exit(0);
}

if (opt.search) {
  const p = PARSERS.find((x) => x.name === opt.search);
  if (!p?.search) {
    console.log(`search: у парсера ${opt.search} нет функции search`);
    process.exit(1);
  }
  const res = await p.search(opt.query || "frontend", { remoteOnly: false, maxPages: 1 }, kit);
  const cards = Array.isArray(res) ? res : res?.cards || [];
  console.log(`search ${p.name} «${opt.query || "frontend"}» | total ${Array.isArray(res) ? "-" : res?.total ?? "-"} | карточек ${cards.length}`);
  const need = ["id", "url", "title", "company", "salary", "topRub", "remote", "exp", "experience", "responses", "closed"];
  const filled = need.map((k) => `${k} ${cards.filter((c) => c[k] !== undefined && c[k] !== "" && c[k] !== null).length}/${cards.length}`);
  console.log("заполнено: " + filled.join(", "));
  for (const c of cards.slice(0, 8)) console.log("- " + cut(JSON.stringify(c), 300));
  const bad = cards.filter((c) => c.url && classify(c.url).parser !== p.name).length;
  if (bad) console.log(`warn | ${bad} ссылок из выдачи match() не узнаёт`);
  process.exit(0);
}

if (!opt.url) {
  console.log("usage: probe.mjs <url> [--parser <имя>] [--blob N [--path a.b.0]] [--grep <regex>] [--browser] | --search <имя> --query <запрос> | --list");
  process.exit(1);
}

if (opt.parser) {
  const s = classify(opt.url);
  if (s.parser !== opt.parser) console.log(`warn | match() парсера ${opt.parser} не узнал ссылку, классификация: ${s.kind} ${s.parser || ""}`);
  const src = s.parser === opt.parser ? s : { ...s, kind: "parser", parser: opt.parser, id: "", slug: "probe" };
  let v;
  try {
    v = await extract(src);
  } catch (e) {
    console.log("fail | " + e.message);
    process.exit(1);
  }
  const fields = ["original", "found_via", "title", "company", "salary", "location", "experience", "employment", "work_format", "key_skills", "date_posted", "archived", "letter_required", "test_required", "contacts", "channel_name", "method"];
  for (const k of fields) console.log(`${k}: ${v[k] === undefined || v[k] === "" ? "-" : cut(Array.isArray(v[k]) ? v[k].join(", ") : v[k], 160)}`);
  const text = String(v.text || "");
  const lines = text.split("\n").filter((l) => l.trim());
  const short = lines.filter((l) => l.trim().length < 25).length;
  console.log(`slug: ${s.slug} | text: ${text.length} симв., строк ${lines.length}, коротких ${short}`);
  console.log("text начало: " + cut(text.slice(0, 700), 700));
  console.log("text конец: " + cut(text.slice(-250), 250));
  const junk = text.match(/войти|регистрац|cookie|политик\p{L}* конфиденц|все вакансии|похожие вакансии|подписаться|скачать приложение|©/giu);
  if (junk) console.log(`warn | в тексте мусор страницы: ${[...new Set(junk.map((j) => j.toLowerCase()))].slice(0, 6).join(", ")}`);
  if (lines.length > 12 && short / lines.length > 0.5) console.log("warn | больше половины строк короче 25 символов: похоже на меню или список ссылок");
  console.log(`quality: ${quality(v)}`);
  process.exit(0);
}

const { html, via } = await kit.page(opt.url);
const file = [cacheFile(opt.url), cacheFile("dom:" + opt.url)].find((f) => existsSync(f)) || "";

if (opt.grep) {
  const re = new RegExp(opt.grep, "gi");
  let n = 0;
  for (const m of html.matchAll(re)) {
    console.log(`@${m.index}: ${cut(html.slice(Math.max(0, m.index - 100), m.index + m[0].length + 100), 260)}`);
    if (++n >= 20) break;
  }
  console.log(`grep: совпадений показано ${n}`);
  process.exit(0);
}

const blobs = jsonBlobs(html);
if (Number.isInteger(opt.blob)) {
  const b = blobs[opt.blob];
  if (!b) {
    console.log(`blob ${opt.blob} нет, всего ${blobs.length}`);
    process.exit(1);
  }
  let x = b.data;
  for (const k of (opt.path || "").split(".").filter(Boolean)) x = x?.[k];
  if (x && typeof x === "object") console.log(`keys: ${Object.keys(x).slice(0, 60).join(", ")}${Object.keys(x).length > 60 ? " …" : ""}`);
  const out = JSON.stringify(x, null, 1) ?? "undefined";
  console.log(out.length > 4000 ? out.slice(0, 4000) + `\n… обрезано, всего ${out.length} симв.` : out);
  process.exit(0);
}

const KEYS = /^(title|name|position|vacancy|description|descr|text|body|content|salary|compensation|wage|payment|company|employer|organization|hiringOrganization|skills?|keySkills?|tags|experience|workExperience|schedule|employment|remote|workFormat|format|city|area|location|address|published|publishedAt|datePosted|created|archived|closed)$/i;
function paths(data, max = 18) {
  const out = [];
  const walk = (x, p, d) => {
    if (out.length >= max || d > 8 || !x || typeof x !== "object") return;
    const entries = Array.isArray(x) ? x.slice(0, 2).map((v, i) => [String(i), v]) : Object.entries(x);
    for (const [k, v] of entries) {
      const q = p ? `${p}.${k}` : k;
      if (!Array.isArray(x) && KEYS.test(k)) out.push(`${q} = ${Array.isArray(v) ? `[${v.length}]` : v && typeof v === "object" ? "{" + Object.keys(v).slice(0, 5).join(",") + "}" : cut(v, 70)}`);
      if (out.length >= max) return;
      walk(v, q, d + 1);
    }
  };
  walk(data, "", 0);
  return out;
}

console.log(`page: ${via} | ${html.length} симв. | кэш ${file ? fwd(file) : "-"}`);
console.log(`title: ${cut(htmlText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1]), 140)}`);
console.log(`og:title: ${cut(meta(html, "og:title"), 140) || "-"} | og:site_name: ${meta(html, "og:site_name") || "-"}`);
const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => cut(htmlText(m[1]), 100)).filter(Boolean);
console.log(`h1: ${h1.slice(0, 3).join(" | ") || "-"}`);
const jp = ldJobPosting(html);
if (jp) {
  const f = kit.fromJobPosting(jp);
  console.log(`JobPosting: есть | ${Object.entries(f).map(([k, v]) => `${k} ${v ? (k === "text" ? v.length + " симв." : "да") : "-"}`).join(", ")}`);
} else console.log("JobPosting: нет");
console.log(`json-блоков: ${blobs.length}`);
for (const b of blobs.slice(0, 15)) {
  const top = b.data && typeof b.data === "object" ? Object.keys(b.data).slice(0, 10).join(", ") : typeof b.data;
  console.log(`- blob ${b.index} | ${b.kind} | ${b.size} симв. | ключи: ${cut(top, 160)}`);
  for (const p of paths(b.data)) console.log(`    ${p}`);
}
const apis = [...new Set([...html.matchAll(/["'](\/?(?:https?:\/\/[^"'\s]+)?\/(?:api|graphql|gql|v\d)\/[^"'\s<>]{2,120})["']/gi)].map((m) => m[1]))].slice(0, 12);
if (apis.length) console.log("api-адреса в странице:\n" + apis.map((a) => "- " + a).join("\n"));
const gen = mainText(html);
console.log(`общий разбор: ${gen.method}, ${gen.text.length} симв.: ${cut(gen.text.slice(0, 300), 300)}`);
