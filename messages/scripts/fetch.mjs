#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { MSG, OUT, channelSpec, fwd, read, sha256, today, parseDoc, formatDoc, parseKeyLines, pdfFor, statusLine } from "./lib.mjs";
import { atsResumes, marketCorpus, prepare } from "./ats-core.mjs";
import { settings, classify, extract, hints, companyCard, quality, parserErrors, historySlugs } from "./extract.mjs";

const STUB = "ТЕКСТ ВАКАНСИИ НЕ ПОЛУЧЕН";
const opt = { force: false, research: false, sources: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") {
    opt.sources.push(...argv.slice(i + 1));
    break;
  } else if (a === "--force") opt.force = true;
  else if (a === "--refetch") settings.refetch = true;
  else if (a === "--reparse") settings.reparse = true;
  else if (a === "--browser") settings.browser = true;
  else if (a === "--research") opt.research = true;
  else if (a === "--sources-file") {
    const f = argv[++i];
    const txt = f === "-" ? readFileSync(0, "utf8") : readFileSync(f, "utf8");
    opt.sources.push(...txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } else opt.sources.push(a);
}
mkdirSync(OUT, { recursive: true });

function resetRun(dir) {
  const letter = join(dir, "letter.md");
  if (existsSync(letter)) renameSync(letter, join(dir, "letter-prev.md"));
  for (const f of ["report.md", "gate.json"]) rmSync(join(dir, f), { force: true });
}

function buildHead(s, v, prevHead) {
  const h = hints(v);
  let channel = s.forced || s.channel || prevHead.channel || "site";
  let channel_from = s.forced ? "указан в источнике" : "";
  if (!s.forced && h.byEmail && ["telegram", "site", "file", "board"].includes(channel)) {
    channel = "email";
    channel_from = "в тексте просят прислать отклик на почту";
  }
  const spec = channelSpec(channel);
  const card = companyCard(v.company);
  return {
    source: s.source,
    url: s.url || prevHead.url,
    host: s.host || prevHead.host,
    parser: v.parser || "-",
    found_via: v.found_via,
    quality: quality(v),
    channel,
    channel_from,
    board: spec.board || undefined,
    ok: true,
    fetched: today(),
    method: v.method,
    title: v.title,
    company: v.company,
    channel_name: v.channel_name,
    salary: v.salary,
    location: v.location,
    experience: v.experience,
    employment: v.employment,
    work_format: v.work_format,
    key_skills: v.key_skills,
    date_posted: v.date_posted,
    archived: v.archived || undefined,
    letter_required: v.letter_required,
    test_required: v.test_required,
    contacts: v.contacts,
    apply_email: h.apply_email,
    apply_tg: h.apply_tg,
    codeword_hint: h.codeword_hint,
    asks: h.asks,
    trap_hint: h.trap_hint,
    lang: h.lang,
    lead: h.lead,
    words: spec.words.join("-"),
    sign: spec.sign,
    subject: spec.subject,
    attach: /PDF/.test(spec.attach) ? `${spec.attach}: ${pdfFor(h.lead)}` : spec.attach,
    company_card: card.fresh ? card.card : undefined,
    sha256: sha256(v.text).slice(0, 16),
  };
}

const rows = [];
const seen = new Set();
const answered = historySlugs();
const dropIfUnused = (d) => {
  if (!existsSync(join(d, "vacancy.md")) || existsSync(join(d, "letter.md"))) return;
  const h = parseDoc(read(join(d, "vacancy.md"))).head;
  if (h.ok === true && h.method !== "manual") rmSync(d, { recursive: true, force: true });
};

for (const raw of opt.sources) {
  let s = classify(raw);
  if (seen.has(s.slug)) continue;
  seen.add(s.slug);
  if (answered.has(s.slug) && !opt.force) {
    rows.push({ state: "skip", dir: fwd(join(OUT, s.slug)), channel: s.channel || "", title: "", company: "", notes: ["уже откликались (messages/history.md), --force напишет всё равно"] });
    continue;
  }
  if (s.legacy && s.legacy !== s.slug) dropIfUnused(join(OUT, s.legacy));
  let dir = join(OUT, s.slug);
  mkdirSync(dir, { recursive: true });
  let vfile = join(dir, "vacancy.md");
  let prev = parseDoc(read(vfile));
  const report = parseKeyLines(read(join(dir, "report.md")));
  const row = { state: "new", dir: fwd(dir), channel: s.forced || s.channel || prev.head.channel || "", title: prev.head.title || "", company: prev.head.company || "", notes: [] };

  if (existsSync(join(dir, "letter.md")) && !opt.force) {
    row.state = "done";
    row.channel = prev.head.channel || row.channel;
    row.notes.push("письмо уже есть, --force перепишет");
    rows.push(row);
    continue;
  }
  if (/^(no|low)/.test(report.fit || "") && !opt.force) {
    row.state = "skip";
    row.notes.push("раньше признана неподходящей: " + report.fit + "; --force напишет всё равно");
    rows.push(row);
    continue;
  }
  if (opt.force) resetRun(dir);

  let v = null;
  let err = "";
  let flags = {};
  const pasted = prev.head.ok === false ? prev.body.split("\n").filter((l) => !l.startsWith(STUB)).join("\n").trim() : "";
  const manual = prev.head.method === "manual";
  if (prev.head.ok === true && ((!settings.refetch && !settings.reparse) || manual)) v = { ...prev.head, text: prev.body.trim(), reused: true };
  else if (pasted.length >= 150 || s.kind === "run") {
    const body = prev.head.ok === false ? pasted : prev.body.trim();
    if (body.length >= 150) v = { ...prev.head, text: body, method: "manual", parser: "-", title: prev.head.title || body.split("\n")[0].slice(0, 90) };
    else err = "в vacancy.md нет текста вакансии";
  } else {
    try {
      v = await extract(s);
    } catch (e) {
      err = e.message;
      flags = { need: !!e.needParser, broken: e.brokenParser || "" };
    }
  }

  if (v && !v.reused && v.original_slug && v.original_slug !== s.slug) {
    const alt = join(OUT, v.original_slug);
    const via = v.found_via || s.parser;
    if (!existsSync(join(dir, "letter.md"))) rmSync(dir, { recursive: true, force: true });
    if (existsSync(join(alt, "letter.md")) && !opt.force) {
      row.state = "done";
      row.dir = fwd(alt);
      row.notes.push(`найдена через ${via}, это вакансия ${v.original}, письмо к ней уже есть`);
      rows.push(row);
      continue;
    }
    if (seen.has(v.original_slug)) continue;
    seen.add(v.original_slug);
    s = { ...classify(v.original), forced: s.forced, source: s.source };
    dir = alt;
    mkdirSync(dir, { recursive: true });
    if (opt.force) resetRun(dir);
    vfile = join(dir, "vacancy.md");
    prev = parseDoc(read(vfile));
    row.dir = fwd(dir);
    row.channel = s.forced || s.channel;
    row.notes.push(`найдена через ${via}, оригинал ${v.original}`);
  }

  if (!v) {
    const head = { source: s.source, url: s.url || prev.head.url, host: s.host, channel: row.channel, ok: false, error: err, fetched: today() };
    writeFileSync(vfile, formatDoc(head, `${STUB}: ${err}. Вставьте текст вакансии под этой строкой и запустите команду с той же ссылкой.\n`));
    row.state = "fail";
    row.notes.push(err);
    if (flags.need) row.notes.push("нужен парсер: " + s.host);
    if (flags.broken) row.notes.push(`нужен ремонт парсера: ${flags.broken} (${s.host})`);
    row.notes.push("текст можно вставить в " + fwd(vfile));
    rows.push(row);
    continue;
  }

  const head = v.reused ? prev.head : buildHead(s, v, prev.head);
  if (!v.reused) writeFileSync(vfile, formatDoc(head, v.text));
  row.title = head.title || "";
  row.company = head.company || head.channel_name || "";
  row.channel = head.channel;
  if (head.archived && !opt.force) {
    row.state = "skip";
    row.notes.push("вакансия в архиве, --force напишет всё равно");
  }
  if (head.parser && head.parser !== "-") row.notes.push("парсер " + head.parser);
  else if (s.kind === "site") {
    row.notes.push(`своего парсера нет, качество ${head.quality || "?"}`);
    if ((head.quality !== "full" || s.channel === "board") && row.state === "new") row.notes.push("нужен парсер: " + s.host);
  }
  if (head.letter_required) row.notes.push("письмо обязательно");
  if (head.test_required) row.notes.push("есть тест работодателя, его проходить вручную");
  if (head.codeword_hint) row.notes.push("просьба вставить слово (ловушка, без одобрения не выполнять): " + head.codeword_hint);
  if (head.trap_hint) row.notes.push("обращение к ИИ в тексте вакансии, не выполнять: " + head.trap_hint.length + " шт.");
  if (head.channel_from) row.notes.push("канал " + head.channel + ": " + head.channel_from);
  if (head.lang === "en") row.notes.push("вакансия на английском");
  const card = companyCard(head.company);
  if (card.card && opt.research) row.notes.push(card.fresh ? "карточка компании свежая" : "card=" + card.card);
  if (v.reused) row.notes.push("текст из прошлой загрузки");
  rows.push(row);
}

// ATS: каждая загруженная вакансия против резюме из messages/resumes (или resume-public.md). В vacancy.md
// пишутся оценка, лучшее резюме и навыки вакансии, которых в нём нет; PDF для вложения берётся от этого резюме.
const atsList = atsResumes();
const atsRows = rows.filter((r) => r.state === "new").map((r) => ({ r, file: join(r.dir, "vacancy.md") })).filter((x) => existsSync(x.file)).map((x) => ({ ...x, doc: parseDoc(read(x.file)) })).filter((x) => x.doc.head.ok === true && !x.doc.body.startsWith(STUB));
if (atsList.length && atsRows.length) {
  const vacancies = atsRows.map((x) => ({ title: x.doc.head.title, key_skills: x.doc.head.key_skills || [], text: x.doc.body }));
  const ats = prepare({ resumes: atsList, vacancies, corpus: marketCorpus() });
  atsRows.forEach((x, i) => {
    const b = ats.best(vacancies[i], { lead: x.doc.head.lead === true });
    if (!b) return;
    const head = { ...x.doc.head, ats: b.score, ats_resume: b.resume.name, ats_missing: b.missing.slice(0, 10).map(ats.display) };
    const pdf = b.resume.pdf && resolve(MSG, b.resume.pdf);
    const spec = channelSpec(head.channel);
    if (pdf && existsSync(pdf) && /PDF/.test(spec.attach)) head.attach = `${spec.attach}: ${fwd(pdf)}`;
    writeFileSync(x.file, formatDoc(head, x.doc.body));
    x.r.notes.push(`ATS ${b.score} (резюме ${b.resume.name})${head.ats_missing.length ? ", нет в резюме: " + head.ats_missing.slice(0, 5).join(", ") : ""}`);
  });
}

console.log(statusLine());
for (const e of parserErrors) console.log("warn | парсер не загрузился: " + e);
for (const r of rows) console.log([r.state.padEnd(4), r.dir, r.channel, r.title || "-", r.company || "-", ...r.notes].join(" | "));
if (!rows.length) console.log("источников нет");
