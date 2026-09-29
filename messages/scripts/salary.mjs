#!/usr/bin/env bun
// Вилка зарплаты для резюме по вилкам вакансий из среза рынка (hh-market.mjs).
//   bun messages/scripts/salary.mjs --resume react --resume vue --resume lead
//   --resume     ключ резюме (messages/resumes/<ключ>.md); срез и фильтр берутся из полей market и where в шапке
//   --jobs       свой срез вместо market из шапки
//   --min-ats    брать вакансии, где резюме закрывает не меньше N по ATS (по умолчанию 50)
//   --all-levels не отсеивать вакансии ниже уровня резюме (по умолчанию для Senior и Lead резюме отсеиваются middle и «1-3 года»)
//   --tax        доля на руки для вилок «до вычета» (по умолчанию 0.87)
// Считаются только рублёвые вилки, всё приводится к «на руки». Итог только подсказка: сумму в резюме выбирает пользователь.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OUT, fwd, read } from "./lib.mjs";
import { atsResumes, prepare } from "./ats-core.mjs";
import { RATES } from "./parsers/hh.mjs";

const argv = process.argv.slice(2);
const all = (f) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]] : []));
const opt = (f) => all(f)[0] || "";
const minAts = +(opt("--min-ats") || 50);
const tax = +(opt("--tax") || 0.87);
const allLevels = argv.includes("--all-levels");
const keys = all("--resume");
if (!keys.length) {
  console.log("salary: нужно хотя бы один --resume <ключ>; срез рынка собирает hh-market.mjs");
  process.exit(1);
}
const known = atsResumes();
const rub = (n, cur) => (cur === "RUR" || cur === "RUB" ? n : null);

// «от 200000 до 300000 RUR на руки» → { from, to, cur, net }
function parse(s) {
  const m = String(s || "").match(/^(?:от (\d+))?\s*(?:до (\d+))?\s*([A-Z]{3})?\s*(на руки|до вычета)?/);
  if (!m || !(m[1] || m[2])) return null;
  const cur = m[3] || "RUR";
  if (!(cur in RATES) || rub(1, cur) === null) return { skip: cur };
  const k = m[4] === "до вычета" ? tax : 1;
  return { from: m[1] ? Math.round(+m[1] * k) : null, to: m[2] ? Math.round(+m[2] * k) : null };
}
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((a.length - 1) * p + 0.5))] : null);
const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { n: s.length, p25: pct(s, 0.25), med: pct(s, 0.5), p75: pct(s, 0.75) };
};
const fmt = (n) => (n == null ? "-" : Math.round(n / 1000) * 1000).toLocaleString("ru-RU").replace(/\s/g, " ");
const row = (label, st) => `| ${label} | ${st.n} | ${fmt(st.p25)} | ${fmt(st.med)} | ${fmt(st.p75)} |`;
const levelOf = (t) => (/lead|лид(?!\p{L}*ер)|руковод|head|тимлид|техлид|principal|staff/iu.test(t) ? "lead" : /senior|сеньор|синьор|сениор|ведущ|старш/iu.test(t) ? "senior" : "-");

mkdirSync(join(OUT, "salary"), { recursive: true });
for (const key of keys) {
  const r = known.find((x) => x.name === key);
  if (!r) {
    console.log(`salary: нет резюме «${key}» в messages/resumes`);
    continue;
  }
  const file = opt("--jobs") || join(OUT, "market", (r.market || "front") + ".jsonl");
  if (!existsSync(file)) {
    console.log(`salary: нет среза ${fwd(file)}; сначала bun messages/scripts/hh-market.mjs`);
    continue;
  }
  const where = r.where ? new RegExp(r.where, "iu") : null;
  const jobs = read(file).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((v) => !where || where.test(v.title + " " + (v.key_skills || []).join(" ")));
  const ats = prepare({ resumes: [r], vacancies: jobs });
  const myLevel = levelOf(r.title || "");
  let noPay = 0, foreign = 0, lowFit = 0, lowLevel = 0;
  const used = [];
  for (const v of jobs) {
    const p = parse(v.salary);
    if (!p) { noPay++; continue; }
    if (p.skip) { foreign++; continue; }
    if ((ats.score(r, v).score ?? 0) < minAts) { lowFit++; continue; }
    if (!allLevels && myLevel !== "-" && levelOf(v.title) === "-" && (v.exp === "1-3" || v.level === "middle")) { lowLevel++; continue; }
    used.push({ ...p, v });
  }
  const from = used.filter((x) => x.from).map((x) => x.from);
  const to = used.filter((x) => x.to).map((x) => x.to);
  const both = used.filter((x) => x.from && x.to).map((x) => (x.from + x.to) / 2);
  const st = { from: stat(from), to: stat(to), mid: stat(both) };
  const same = used.filter((x) => levelOf(x.v.title) === myLevel && myLevel !== "-");
  const sameSt = same.length >= 5 ? { from: stat(same.filter((x) => x.from).map((x) => x.from)), to: stat(same.filter((x) => x.to).map((x) => x.to)) } : null;
  const ask = st.mid.med ?? st.from.med;
  const enough = used.length >= 10;
  let md = `# Зарплата: ${key} (${r.title || ""})\n\nСрез ${fwd(file)}, вакансий под фильтр ${jobs.length}. Без вилки: ${noPay}; не в рублях: ${foreign}; ATS ниже ${minAts}: ${lowFit}; ниже уровня резюме: ${lowLevel}. В расчёте: **${used.length}**. Суммы на руки, рубли, округлено до тысяч; вилки «до вычета» умножены на ${tax}.\n\n`;
  md += `| Показатель | Вакансий | 25% | Медиана | 75% |\n|---|---|---|---|---|\n${row("Нижняя граница («от»)", st.from)}\n${row("Верхняя граница («до»)", st.to)}\n${row("Середина вилки (есть обе границы)", st.mid)}\n`;
  if (sameSt) md += `${row(`«от» только вакансии уровня ${myLevel}`, sameSt.from)}\n${row(`«до» только вакансии уровня ${myLevel}`, sameSt.to)}\n`;
  md += `\n## Подсказка\n\n`;
  md += enough
    ? `- Ориентир для поля «Зарплата»: **${fmt(ask)}** на руки (медиана середины вилок подходящих вакансий). Ниже ${fmt(st.from.p25)} рынок начинается, выше ${fmt(st.to.p75)} почти не платят.\n- В резюме сейчас: ${r.salary || "не указана"} ${r.currency || ""}.\n`
    : `- Вилок мало (${used.length}), вывод ненадёжен: расширьте срез (hh-market.mjs с другими запросами) или ослабьте --min-ats.\n`;
  md += `- Вилки в вакансиях это ожидания работодателя, а не финальный оффер; у ${Math.round((100 * noPay) / (jobs.length || 1))}% вакансий зарплаты нет, и они в расчёт не попали.\n- Решение о сумме за пользователем: скрипт ничего не правит в резюме.\n`;
  md += `\n## Вакансии в расчёте (10 с самой высокой верхней границей)\n\n` + used.filter((x) => x.to).sort((a, b) => b.to - a.to).slice(0, 10).map((x) => `- ${x.v.salary}: ${x.v.title}, ${x.v.company} ${x.v.url || ""}`).join("\n") + "\n";
  const base = join(OUT, "salary", key);
  writeFileSync(base + ".md", md);
  writeFileSync(base + ".json", JSON.stringify({ resume: key, used: used.length, noPay, foreign, lowFit, lowLevel, from: st.from, to: st.to, mid: st.mid, suggest: enough ? Math.round(ask / 1000) * 1000 : null }, null, 1));
  console.log(`salary: ${key}: в расчёте ${used.length} из ${jobs.length}; «от» медиана ${fmt(st.from.med)}, «до» медиана ${fmt(st.to.med)}, ориентир ${enough ? fmt(ask) : "мало данных"} (в резюме ${r.salary || "-"}) → ${fwd(base + ".md")}`);
}
