export const name = "getmatch";
export const channel = "board";
export const hosts = ["getmatch.ru"];

const EMPLOY = { FULL_TIME: "полная", PART_TIME: "частичная", CONTRACTOR: "проектная", TEMPORARY: "временная", INTERN: "стажировка" };
const RATES = { RUB: 1, RUR: 1, USD: 90, EUR: 100 };

const clean = (s) =>
  String(s || "")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();

function section(html, cls) {
  const m = html.match(new RegExp(`<section class="${cls}[^"]*">([\\s\\S]*?)<\\/section>`, "i"));
  return m ? m[1] : "";
}

function tagTitles(chunk) {
  return [...chunk.matchAll(/__title">([^<]*)</g)].map((m) => clean(m[1])).filter(Boolean);
}

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (!/(^|\.)getmatch\.ru$/.test(h)) return null;
  const m = u.pathname.match(/^\/vacancies\/(\d+)(-[a-z0-9-]+)?\/?$/i);
  if (!m) return { error: "не ссылка на вакансию getmatch" };
  const id = m[1];
  const rest = m[2] || "";
  return { id, url: `https://getmatch.ru/vacancies/${id}${rest}`, slug: "getmatch-" + id };
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const jp = kit.ldJobPosting(html);
  if (!jp) throw new kit.NetError("на странице нет описания вакансии (JobPosting), похоже вакансию сняли");
  const v = { ...kit.fromJobPosting(jp), method: "getmatch ld+json/" + via };

  const head = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>[\s\S]{0,80}?<a[^>]*href="\/companies\/[^"]*"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>(?:\s*<h3[^>]*>([\s\S]*?)<\/h3>)?/i);
  if (head) {
    v.title = clean(kit.htmlText(head[1])) || v.title;
    v.company = clean(kit.htmlText(head[2])) || v.company;
    if (head[3]) v.salary = clean(kit.htmlText(head[3]));
  }

  const locTags = tagTitles(section(html, "b-location"));
  const cities = locTags.filter((t) => t.includes("📍")).map((t) => t.replace(/📍\s*/g, "").trim());
  const fmt = locTags.find((t) => !t.includes("📍"));
  if (cities.length) v.location = cities.join(", ");
  if (fmt) v.work_format = fmt.toLowerCase();

  const specs = {};
  for (const m of html.matchAll(/<div class="col b-term">([^<]*)<\/div><div class="col b-value">([\s\S]*?)<\/div>/g)) {
    specs[clean(kit.htmlText(m[1]))] = clean(kit.htmlText(m[2]));
  }
  const expBits = [specs["Уровень"], specs["Требуемый опыт"]].filter(Boolean);
  if (expBits.length) v.experience = expBits.join(", ");

  const skills = [...new Set(tagTitles(section(html, "b-vacancy-stack")))];
  if (skills.length) v.key_skills = skills;

  if (jp.employmentType) v.employment = EMPLOY[jp.employmentType] || v.employment;

  const descChunk = section(html, "b-vacancy-description");
  if (descChunk) {
    const text = kit
      .htmlText(descChunk)
      .replace(/[​‌‍﻿]/g, "")
      .replace(/ /g, " ")
      .trim();
    if (text) v.text = text;
  }

  return v;
}

function salaryNums(text) {
  const nums = (text.match(/\d[\d\s]{2,}\d|\d/g) || []).map((s) => +s.replace(/\s/g, "")).filter((n) => n >= 1000 || /USD|EUR/i.test(text));
  const rate = /USD/i.test(text) ? RATES.USD : /EUR/i.test(text) ? RATES.EUR : RATES.RUB;
  return nums.length ? Math.max(...nums) * rate : null;
}

function cardsFromHtml(html, kit) {
  const out = [];
  const re = /<div class="b-vacancy-card-title"><h3><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>([\s\S]*?)(?=<div class="b-vacancy-card-title">|<section class="b-vacancy-v2|$)/g;
  for (const m of html.matchAll(re)) {
    const mm = m[1].match(/\/vacancies\/(\d+)(-[a-z0-9-]+)?/i);
    if (!mm) continue;
    const id = mm[1];
    const url = `https://getmatch.ru/vacancies/${id}${mm[2] || ""}`;
    const title = clean(kit.htmlText(m[2]));
    const rest = m[3];
    const compM = rest.match(/<h4>[^<]*<a[^>]*href="\/companies\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const company = compM ? clean(kit.htmlText(compM[1])) : "";
    const salM = rest.match(/b-vacancy-card-subtitle__salary">([\s\S]*?)<\/div>/i);
    const salary = salM ? clean(kit.htmlText(salM[1])) : "";
    const topRub = salary ? salaryNums(salary) : null;
    const tags = tagTitles(rest);
    const remote = tags.some((t) => /удал[её]нно/i.test(t)) ? true : tags.some((t) => /офис|гибрид/i.test(t)) ? false : null;
    const descM = rest.match(/b-vacancy-card-description">([\s\S]{0,2000})/i);
    const snippet = descM ? clean(kit.htmlText(descM[1])) : "";
    out.push({ id, url, title, company, salary, topRub, remote, snippet });
  }
  return out;
}

export async function search(query, opt, kit) {
  const { html } = await kit.page("https://getmatch.ru/vacancies", { allowBrowser: true });
  let cards = cardsFromHtml(html, kit);
  if (opt.remoteOnly) cards = cards.filter((c) => c.remote !== false);
  const q = (query || "").trim().toLowerCase();
  if (q)
    cards = cards.filter((c) => c.title.toLowerCase().includes(q) || c.company.toLowerCase().includes(q) || c.snippet.toLowerCase().includes(q));
  for (const c of cards) delete c.snippet;
  return { cards, total: cards.length };
}
