// Резюме для hh в Markdown: один файл на резюме в messages/resumes/<ключ>.md. Формат в messages/resume-hh.example.md.
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { MSG, read, parseDoc, formatDoc, sha256 } from "../lib.mjs";

export const RESUMES_DIR = join(MSG, "resumes");
const csv = (s) => (s ? String(s).split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => (d ? `${pad(d[0])}.${d[1]}` : "сейчас");
function parseDate(s) {
  if (/сейчас/i.test(s)) return null;
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{4})$/);
  return m ? [+m[1], +m[2]] : undefined;
}
const sections = (body) => Object.fromEntries(body.split(/^## /m).slice(1).map((s) => { const i = s.indexOf("\n"); return [s.slice(0, i).trim(), s.slice(i + 1)]; }));

export function parseResumeMd(text, key) {
  const { head, body } = parseDoc(text);
  const problems = [];
  const sec = sections(body);
  const lv = String(head.levels || "").split(";").map((x) => x.trim()).filter(Boolean);
  const levels = lv.length ? Object.fromEntries([["default", lv[0]], ...lv.slice(1).map((x) => x.split(/\s*=\s*/))]) : undefined;
  const resume = {
    hash: String(head.hash || ""),
    title: head.title || undefined,
    salary: head.salary ? +String(head.salary).replace(/\D/g, "") : undefined,
    currency: head.currency || undefined,
    employment: csv(head.employment),
    format: csv(head.format),
    trips: head.trips || undefined,
    market: head.market || undefined,
    where: head.where || undefined,
    pdf: head.pdf || undefined,
    levels,
    skills: sec["Навыки"] !== undefined ? sec["Навыки"].split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : undefined,
    about: sec["О себе"] !== undefined ? sec["О себе"].trim() : undefined,
  };
  const jobs = [];
  for (const part of (sec["Опыт"] || "").split(/^### /m).slice(1)) {
    const lines = part.split("\n");
    const company = lines.shift().trim();
    const meta = {};
    while (lines.length && /^- (должность|период|компания):/.test(lines[0])) {
      const [, k, v] = lines.shift().match(/^- (\S+):\s*(.*)$/);
      meta[k] = v.trim();
    }
    const job = { company, position: meta["должность"] || "", text: lines.join("\n").trim() };
    const [from, to] = String(meta["период"] || "").split(/\s+-\s+/);
    job.start = parseDate(from || "");
    job.end = parseDate(to || "");
    if (!job.position) problems.push(`${key}: «${company}»: нет строки «- должность:»`);
    if (!job.start || job.end === undefined) problems.push(`${key}: «${company}»: период пишется как «03.2026 - сейчас» или «01.2025 - 03.2026»`);
    const c = meta["компания"] || "";
    if (/из базы hh/i.test(c)) job.employer = true;
    else {
      const [region, site, industry] = c.split(";").map((x) => x.trim());
      Object.assign(job, { region, site: site || undefined, industry });
      if (!region || !industry) problems.push(`${key}: «${company}»: «- компания:» это «из базы hh» или «город; сайт; сфера деятельности»`);
    }
    if (!job.text) problems.push(`${key}: «${company}»: пустой текст`);
    jobs.push(job);
  }
  return { key, resume, jobs, problems, digest: sha256(text) };
}

// Все файлы messages/resumes/*.md в одну спецификацию: место работы объединяется по компании, должности и началу.
export function loadResumes(dir = RESUMES_DIR) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  const spec = { resumes: {}, jobs: [], problems: [], digests: {}, files: {} };
  for (const f of files) {
    const key = basename(f, ".md");
    const r = parseResumeMd(read(join(dir, f)), key);
    spec.resumes[key] = r.resume;
    spec.digests[key] = r.digest;
    spec.files[key] = join(dir, f);
    spec.problems.push(...r.problems);
    for (const j of r.jobs) {
      const same = spec.jobs.find((x) => x.company === j.company && x.position === j.position && String(x.start) === String(j.start));
      const { text, ...meta } = j;
      if (same) same.texts[key] = text;
      else spec.jobs.push({ ...meta, texts: { [key]: text } });
    }
  }
  return spec;
}

export function resumeMd(key, r, jobs) {
  const head = {
    hash: r.hash,
    title: r.title,
    salary: r.salary,
    currency: r.currency,
    employment: r.employment?.join(", "),
    format: r.format?.join(", "),
    trips: r.trips,
    market: r.market,
    where: r.where,
    pdf: r.pdf,
    levels: r.levels ? [r.levels.default, ...Object.entries(r.levels).filter(([k]) => k !== "default").map(([k, v]) => `${k}=${v}`)].join("; ") : undefined,
  };
  let body = `# ${r.title || key}\n\n## Навыки\n\n${(r.skills || []).join(", ")}\n\n## О себе\n\n${r.about || ""}\n\n## Опыт\n`;
  for (const j of jobs) {
    if (!j.texts?.[key]) continue;
    const company = j.employer ? "из базы hh" : [j.region, j.site || "", j.industry].join("; ");
    body += `\n### ${j.company}\n- должность: ${j.position}\n- период: ${fmtDate(j.start)} - ${fmtDate(j.end)}\n- компания: ${company}\n\n${j.texts[key]}\n`;
  }
  return formatDoc(head, body);
}

export function writeResumes(spec, dir = RESUMES_DIR) {
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [key, r] of Object.entries(spec.resumes)) {
    const file = join(dir, key + ".md");
    writeFileSync(file, resumeMd(key, r, spec.jobs));
    out.push(file);
  }
  return out;
}
