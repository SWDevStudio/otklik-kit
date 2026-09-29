#!/usr/bin/env bun
// Резюме на hh.ru из файлов messages/resumes/<ключ>.md (формат: messages/resume-hh.example.md).
//   login                  открыть отдельный Chrome на входе в hh (войти в нём один раз)
//   list                   резюме аккаунта и все записи опыта в профиле с привязкой к резюме
//   init [--force]         собрать messages/resumes/*.md из того, что сейчас на hh
//   check [--resume k,k]   формат, humanizer-ru и ATS по срезу рынка; без пройденной проверки заливки нет
//   apply [--save] [--resume k,k] [--only position,about,skills,levels,experience]
//                          без --save формы заполняются и проверяются, но не сохраняются
//   verify [--resume k,k]  сверить опубликованные резюме с файлами
//   pdf [--resume k,k]     скачать PDF резюме с hh в messages/ (имя из поля pdf в шапке, иначе resume-<ключ>.pdf)
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MSG, OUT, fwd, read, findScanner } from "./lib.mjs";
import { launch, connect, PROFILE_DIR, PORT } from "./hh/cdp.mjs";
import { MONTHS, norm, fillExperience, setSkills, setLevels, setAbout, setPosition, listResumes, listExperience, readResume, resumeText } from "./hh/ui.mjs";
import { loadResumes, writeResumes, RESUMES_DIR } from "./hh/spec.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (f) => argv.includes(f);
const opt = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : "");
const DIR = opt("--dir") || RESUMES_DIR;
const SAVE = flag("--save");
const CHECKS = join(OUT, "hh-check");
const HERE = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

function loadSpec() {
  const spec = loadResumes(DIR);
  const keys = Object.keys(spec.resumes);
  if (!keys.length) {
    log(`hh-resume: нет ${fwd(DIR)}/*.md: выполните init или скопируйте messages/resume-hh.example.md в messages/resumes/<ключ>.md`);
    process.exit(1);
  }
  const bad = [...spec.problems];
  for (const [k, r] of Object.entries(spec.resumes)) {
    if (!/^[0-9a-f]{20,}$/.test(r.hash)) bad.push(`${k}: в шапке нет hash резюме (его показывает list)`);
    if (r.skills && r.skills.length > 30) bad.push(`${k}: ${r.skills.length} навыков, hh принимает не больше 30`);
    if (r.about && /\*\*|—|–/.test(r.about)) bad.push(`${k}: «О себе»: markdown или длинное тире, hh покажет их как есть`);
  }
  for (const j of spec.jobs) for (const [k, t] of Object.entries(j.texts)) if (/\*\*|—|–|^#/m.test(t)) bad.push(`${k}: «${j.company}»: markdown или длинное тире в тексте, hh покажет их как есть`);
  if (bad.length) {
    log("hh-resume: ошибки в резюме\n" + bad.map((b) => "- " + b).join("\n"));
    process.exit(1);
  }
  return spec;
}
const pickResumes = (spec) => {
  const only = opt("--resume").split(",").filter(Boolean);
  return Object.entries(spec.resumes).filter(([k]) => !only.length || only.includes(k));
};
const blocks = () => {
  const only = opt("--only").split(",").filter(Boolean);
  return (b) => !only.length || only.includes(b);
};
const stampFile = (k) => join(CHECKS, k + ".json");

if (cmd === "login") {
  const started = await launch("https://hh.ru/account/login");
  log(started ? `открыт Chrome с отдельным профилем (${fwd(PROFILE_DIR)}): войдите в hh в этом окне, дальше команды работают в нём` : `Chrome на порту ${PORT} уже запущен: войдите в hh в этом окне, если ещё не вошли`);
  process.exit(0);
}

// Проверка перед заливкой: формат, humanizer-ru (жёсткие запреты), ATS по срезу рынка. Отметка привязана к содержимому файла.
if (cmd === "check") {
  const spec = loadSpec();
  mkdirSync(CHECKS, { recursive: true });
  const sc = findScanner();
  let failed = 0;
  for (const [k, r] of pickResumes(spec)) {
    const texts = [r.about, ...spec.jobs.filter((j) => j.texts[k]).map((j) => j.texts[k])].filter(Boolean);
    const stamp = { digest: spec.digests[k], at: new Date().toISOString() };
    const probs = [];
    if (sc.error) {
      if (flag("--skip-humanizer")) stamp.humanizer = "пропущен по --skip-humanizer";
      else probs.push(`humanizer-ru: ${sc.error} (поставьте его или запустите с --skip-humanizer)`);
    } else {
      const txt = join(CHECKS, k + ".txt");
      writeFileSync(txt, texts.join("\n\n"));
      const run = spawnSync(sc.py, [sc.scan, "--json", txt], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      try {
        const j = JSON.parse(run.stdout);
        stamp.humanizer = { score: j.score?.score, hardBans: j.hard_ban_count, bans: (j.hard_bans || []).map((h) => h.marker || h[0] || h) };
        if (j.hard_ban_count) probs.push(`humanizer-ru: жёстких запретов ${j.hard_ban_count}: ${JSON.stringify(stamp.humanizer.bans).slice(0, 200)}`);
      } catch {
        probs.push("humanizer-ru не отработал: " + String(run.stderr || run.stdout).slice(0, 200));
      }
    }
    const sample = join(OUT, "market", (r.market || "front") + ".jsonl");
    if (!existsSync(sample)) {
      if (flag("--skip-ats")) stamp.ats = "пропущен по --skip-ats";
      else probs.push(`ATS: нет среза рынка ${fwd(sample)}: bun messages/scripts/hh-market.mjs${r.market === "lead" ? " --lead" : ""} (или --skip-ats)`);
    } else {
      const a = spawnSync(process.execPath, [join(HERE, "ats.mjs"), "--jobs", sample, "--resume", k, ...(r.where ? ["--where", r.where] : []), ...(opt("--dir") ? ["--dir", DIR] : [])], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const line = (a.stdout || "").split("\n").find((l) => l.startsWith("ats: "));
      const m = line && line.match(/медиана (\d+), 70\+ у (\d+)%, поле навыков совпадает на (\d+)% → (.*)$/);
      if (!m) probs.push("ATS не отработал: " + String(a.stderr || a.stdout).slice(0, 300));
      else stamp.ats = { median: +m[1], good: +m[2], field: +m[3], report: m[4].trim(), missing: (a.stdout.split("\n").find((l) => l.includes("нет в резюме:")) || "").replace(/^\s*нет в резюме:\s*/, "") };
    }
    if (probs.length) {
      failed++;
      log(`${k}: не прошло\n` + probs.map((p) => "  - " + p).join("\n"));
      continue;
    }
    writeFileSync(stampFile(k), JSON.stringify(stamp, null, 1));
    const h = typeof stamp.humanizer === "object" ? `humanizer ${stamp.humanizer.score}/100, запретов 0` : stamp.humanizer;
    const at = typeof stamp.ats === "object" ? `ATS медиана ${stamp.ats.median}, 70+ у ${stamp.ats.good}%, поле навыков ${stamp.ats.field}%; отчёт ${stamp.ats.report}\n  нет в резюме: ${stamp.ats.missing}` : stamp.ats;
    log(`${k}: проверка пройдена: ${h}; ${at}`);
  }
  log(failed ? "hh-resume: исправьте файлы и повторите check" : "hh-resume: отчёты ATS прочитайте до заливки: навык добавляется, только если он правда есть в опыте. Любая правка файла сбрасывает отметку");
  process.exit(failed ? 1 : 0);
}

const page = await connect();
if (!(await page.url()).includes("hh.ru")) await page.goto("https://hh.ru/applicant/resumes");
if (/account\/login/.test(await page.url())) {
  log("hh-resume: вход в hh не выполнен: войдите в окне браузера и повторите");
  process.exit(1);
}

if (cmd === "list") {
  const resumes = await listResumes(page);
  log("Резюме:");
  for (const r of resumes) log(`  ${r.hash}  ${r.title}`);
  log("Записи опыта в профиле:");
  await listExperience(page, (s) => log("  " + s));
  page.close();
  process.exit(0);
}

if (cmd === "init") {
  if (existsSync(DIR) && loadResumes(DIR).files && Object.keys(loadResumes(DIR).files).length && !flag("--force")) {
    log(`hh-resume: в ${fwd(DIR)} уже есть резюме, перезаписать: init --force`);
    process.exit(1);
  }
  const resumes = await listResumes(page);
  const spec = { resumes: {}, jobs: [] };
  const keyOf = new Map(resumes.map((r, i) => [r.title, `resume${i + 1}`]));
  for (const r of resumes) {
    log("читаю резюме", r.title);
    const { hash, ...rest } = await readResume(page, r.hash);
    spec.resumes[keyOf.get(r.title)] = { hash, ...rest, levels: { default: "Продвинутый" } };
  }
  log("читаю записи опыта");
  const entries = await listExperience(page, (s) => log("  " + s));
  for (const e of entries) {
    const attached = e.resumes.filter((b) => b.checked).map((b) => [...keyOf].find(([t]) => norm(b.t).startsWith(norm(t).slice(0, 30)))?.[1]).filter(Boolean);
    if (!attached.length) continue;
    const start = [MONTHS.indexOf(e.months[0]), +e.startYear];
    const end = e.now ? null : [MONTHS.indexOf(e.months[1]), +e.endYear];
    let job = spec.jobs.find((j) => norm(j.company) === norm(e.company) && norm(j.position) === norm(e.position) && String(j.start) === String(start));
    if (!job) {
      job = { company: e.company, position: e.position, start, end, texts: {} };
      if (e.employer) job.employer = true;
      else Object.assign(job, { region: e.region, site: e.site || undefined, industry: e.industry });
      spec.jobs.push(job);
    }
    for (const k of attached) job.texts[k] = e.text;
  }
  const files = writeResumes(spec, DIR);
  log(`hh-resume: записано ${files.length}: ${files.map(fwd).join(", ")}. Файлы можно переименовать (react.md, lead.md): имя файла это ключ резюме. Дальше правка текстов, check и apply`);
  page.close();
  process.exit(0);
}

if (cmd === "apply") {
  const spec = loadSpec();
  const on = blocks();
  const chosen = pickResumes(spec);
  if (SAVE) {
    const stale = chosen.filter(([k]) => {
      try {
        return JSON.parse(read(stampFile(k))).digest !== spec.digests[k];
      } catch {
        return true;
      }
    }).map(([k]) => k);
    if (stale.length) {
      log(`hh-resume: не заливаю: для ${stale.join(", ")} нет пройденной проверки на текущей версии файла. Сначала: bun messages/scripts/hh-resume.mjs check --resume ${stale.join(",")}`);
      process.exit(1);
    }
  }
  const account = await listResumes(page);
  for (const [k, r] of chosen) if (!account.some((a) => a.hash === r.hash)) {
    log(`hh-resume: резюме ${k} (${r.hash}) нет в аккаунте`);
    process.exit(1);
  }
  const mode = SAVE ? "сохраняю" : "проверка без сохранения";
  for (const [k, r] of chosen) {
    if (on("position") && (r.title || r.salary !== undefined || r.employment || r.format || r.trips)) {
      await setPosition(page, r.hash, r, SAVE);
      log(`${k}: название и условия, ${mode}`);
    }
    if (on("about") && r.about) {
      await setAbout(page, r.hash, r.about, SAVE);
      log(`${k}: «О себе», ${mode}`);
    }
    if (on("skills") && r.skills) {
      const s = await setSkills(page, r.hash, r.skills, SAVE);
      log(`${k}: навыки ${s.final.length}${s.missing.length ? ", не добавились: " + s.missing.join(", ") : ""}, ${mode}`);
    }
    if (on("levels") && r.levels) {
      const l = await setLevels(page, r.hash, r.levels, SAVE);
      log(`${k}: уровни у ${l.skills} навыков${l.wrong.length ? ", не выставились: " + l.wrong.join(", ") : ""}, ${mode}`);
    }
  }
  if (on("experience")) {
    // Названия резюме в блоке «Резюме с этим местом работы»: после сохранения position это названия из файлов.
    const titleOf = Object.fromEntries(Object.entries(spec.resumes).map(([k, r]) => [k, SAVE && on("position") && r.title ? r.title : account.find((a) => a.hash === r.hash)?.title || r.title]));
    const managedKeys = chosen.map(([k]) => k);
    const managed = managedKeys.map((k) => titleOf[k]);
    log("читаю записи опыта в профиле");
    const entries = await listExperience(page);
    const used = new Set();
    for (const job of spec.jobs) {
      // одинаковые тексты hh склеивает в одну запись, поэтому одна запись на уникальный текст
      const units = new Map();
      for (const [k, t] of Object.entries(job.texts)) if (managedKeys.includes(k)) units.set(t, [...(units.get(t) || []), k]);
      for (const [text, keys] of units) {
        const want = keys.map((k) => titleOf[k]);
        const e = entries.find((x) => !used.has(x.id) && norm(x.company) === norm(job.company) && x.text === text);
        if (e) used.add(e.id);
        const attachedNow = e ? e.resumes.filter((b) => b.checked).map((b) => b.t) : [];
        const sameAttach = e && managed.every((m) => attachedNow.some((t) => norm(t).startsWith(norm(m).slice(0, 30))) === want.includes(m));
        if (e && sameAttach) {
          log(`${job.company} [${keys.join(",")}]: уже как в файле`);
          continue;
        }
        await fillExperience(page, { id: e?.id, resumeFrom: spec.resumes[keys[0]].hash, job, text, managed, want, save: SAVE });
        log(`${job.company} [${keys.join(",")}]: ${e ? "привязка исправлена" : "новая запись"}, ${mode}`);
      }
    }
    // Лишние записи: привязаны к управляемому резюме, но в файлах их нет. Запись не удаляется, только отвязывается.
    for (const e of entries) {
      if (used.has(e.id)) continue;
      const attached = managed.filter((m) => e.resumes.some((b) => b.checked && norm(b.t).startsWith(norm(m).slice(0, 30))));
      if (!attached.length) continue;
      await fillExperience(page, { id: e.id, resumeFrom: spec.resumes[managedKeys[0]].hash, job: { company: e.company }, text: e.text, managed, want: [], save: SAVE });
      log(`${e.company} (${e.position}): отвязана от ${attached.join(" | ")}, ${mode}`);
    }
  }
  log(SAVE ? "hh-resume: готово, сверка: verify" : "hh-resume: формы заполнились без ошибок, ничего не сохранено; для записи нужен --save");
  page.close();
  process.exit(0);
}

if (cmd === "verify") {
  const spec = loadSpec();
  let bad = 0;
  for (const [k, r] of pickResumes(spec)) {
    const v = await resumeText(page, r.hash);
    const want = spec.jobs.filter((j) => j.texts[k]);
    const miss = want.filter((j) => !v.body.includes(norm(j.texts[k])));
    const probs = [];
    if (r.title && v.title !== norm(r.title)) probs.push(`название «${v.title}»`);
    if (v.jobs !== want.length) probs.push(`мест работы ${v.jobs} вместо ${want.length}`);
    if (miss.length) probs.push("не совпал текст: " + miss.map((j) => j.company).join(", "));
    if (r.about && !v.body.includes(norm(r.about).slice(0, 120))) probs.push("«О себе» не совпал");
    if (r.skills) {
      const cur = (await readResume(page, r.hash)).skills.map((s) => s.toLowerCase());
      const lost = r.skills.filter((s) => !cur.includes(s.toLowerCase()));
      if (lost.length || cur.length !== r.skills.length) probs.push(`навыки: ${cur.length} на hh, нет ${lost.join(", ") || "-"}`);
    }
    bad += probs.length ? 1 : 0;
    log(`${k}: ${probs.length ? probs.join("; ") : "всё как в файле"}`);
  }
  page.close();
  process.exit(bad ? 1 : 0);
}

if (cmd === "pdf") {
  const spec = loadSpec();
  for (const [k, r] of pickResumes(spec)) {
    const b64 = await page.eval(async (hash) => {
      const res = await fetch(`/resume_converter/resume.pdf?hash=${hash}&type=pdf`, { credentials: "include" });
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, r.hash);
    const data = b64 ? Buffer.from(b64, "base64") : null;
    if (!data || data.subarray(0, 4).toString() !== "%PDF") {
      log(`${k}: hh не отдал PDF`);
      continue;
    }
    const file = join(MSG, r.pdf || `resume-${k}.pdf`);
    writeFileSync(file, data);
    log(`${k}: ${fwd(file)} (${Math.round(data.length / 1024)} КБ)`);
  }
  page.close();
  process.exit(0);
}

log("hh-resume: команды login, list, init, check, apply [--save], verify, pdf. Подробности в начале файла");
page.close();
