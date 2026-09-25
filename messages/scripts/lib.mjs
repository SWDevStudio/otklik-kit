import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const MSG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(MSG, "..");
export const OUT = join(MSG, "out");
export const CACHE = join(MSG, ".cache");
export const COMPANIES = join(MSG, "companies");
export const JOBS = join(MSG, "jobs");
export const RULES = join(MSG, "rules");
export const CONFIG = join(MSG, "config");
export const PARSERS_DIR = join(MSG, "scripts", "parsers");
export const PROFILE = join(MSG, "profile.md");
export const RESUME = join(MSG, "resume-public.md");
export const CANDIDATE = join(MSG, "candidate.json");

export const fwd = (p) => p.replace(/\\/g, "/");
export const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n") : "");
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const today = () => new Date().toISOString().slice(0, 10);
export const ageDays = (p) => (existsSync(p) ? (Date.now() - statSync(p).mtimeMs) / 864e5 : Infinity);

export function runDir(arg) {
  if (!arg) throw new Error("не указан каталог вакансии");
  const cands = isAbsolute(arg) ? [arg] : [resolve(arg), resolve(REPO, arg), resolve(OUT, arg)];
  const hit = cands.find((p) => existsSync(join(p, "vacancy.md")));
  if (!hit) throw new Error("нет vacancy.md в " + arg);
  return hit;
}

export function jobFile(slug) {
  const done = join(JOBS, "_" + slug + ".md");
  return existsSync(done) ? done : join(JOBS, slug + ".md");
}

export function parseDoc(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { head: {}, body: text };
  const head = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(": ");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 2).trim();
    if (/^["[{]/.test(v)) {
      try {
        v = JSON.parse(v);
      } catch {}
    } else if (v === "true" || v === "false") v = v === "true";
    head[k] = v;
  }
  return { head, body: m[2].replace(/^\n+/, "") };
}

export function formatDoc(head, body) {
  const lines = Object.entries(head)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${typeof v === "string" && !/^["[{]/.test(v) && !/\n/.test(v) && v.trim() === v ? v : JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

export function parseKeyLines(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return out;
}

export function slugify(s, max = 50) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export function candidate() {
  let c = {};
  try {
    c = JSON.parse(read(CANDIDATE) || "{}");
  } catch {}
  const name = String(c.name || "").trim();
  const links = c.links || {};
  return {
    name,
    short: String(c.short_name || "").trim() || name.split(/\s+/)[0] || "",
    links: { site: links.site || "", github: links.github || "", telegram: links.telegram || "" },
    pdf: c.pdf || {},
  };
}

export function channelSpec(channel) {
  const c = candidate();
  const { site, github, telegram } = c.links;
  const links = [site, github].filter(Boolean).join(" и ");
  const form = { words: [60, 130], attach: site ? `PDF, если форма принимает файл, иначе ссылка ${site}` : "PDF, если форма принимает файл", sign: c.name };
  const specs = {
    hh: { words: [60, 130], attach: "ничего: отклик уходит вместе с резюме на hh.ru", sign: c.short, board: true },
    habr_career: { words: [60, 130], attach: links ? `ссылки в тексте письма: ${links}` : "ничего: отклик уходит вместе с профилем на Хабр Карьере", sign: [c.name, github].filter(Boolean).join(", "), board: true },
    board: { words: [60, 130], attach: "ничего: отклик уходит вместе с резюме на площадке", sign: c.short, board: true },
    telegram: { words: [40, 90], attach: "PDF файлом следом за сообщением", sign: c.short },
    email: { words: [60, 180], attach: "PDF во вложении", sign: [c.name, telegram && "Telegram " + telegram].filter(Boolean).join(", "), subject: `Отклик на вакансию <должность>${c.name ? ", " + c.name : ""}` },
    form,
    site: form,
    file: form,
  };
  return specs[channel] || form;
}

export function pdfFor(lead) {
  const { pdf } = candidate();
  const name = (lead && pdf.lead) || pdf.default || "";
  if (!name) return "PDF резюме (путь не указан в candidate.json)";
  const p = isAbsolute(name) ? name : resolve(MSG, name);
  return existsSync(p) ? fwd(p) : name;
}

export function findScanner() {
  const home = homedir();
  const scan = [join(home, ".claude", "skills", "humanizer-ru", "scripts", "scan.py"), join(home, ".agents", "skills", "humanizer-ru", "scripts", "scan.py")].find((p) => existsSync(p));
  if (!scan) return { error: "humanizer-ru не найден" };
  for (const py of ["python", "py", "python3"]) {
    const r = spawnSync(py, ["-c", "import razdel, pymorphy3"], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true });
    if (r.status === 0) return { scan, py };
  }
  return { error: "нет python с razdel и pymorphy3" };
}

export function findBrowser() {
  const env = process.env;
  const x86 = env["ProgramFiles(x86)"];
  const cands = [
    env.CHROME_PATH,
    env.ProgramFiles && join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    x86 && join(x86, "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    x86 && join(x86, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return cands.find((p) => existsSync(p)) || "";
}

export function profileState() {
  const resume = read(RESUME);
  if (!resume.trim()) return { state: "нет messages/resume-public.md" };
  const prof = read(PROFILE);
  const want = sha256(resume);
  if (!prof) return { state: "нет messages/profile.md, нужен --refresh-profile", want };
  const have = (prof.match(/sha256:([0-9a-f]{64})/) || [])[1];
  return { state: have === want ? "профиль актуален" : "профиль устарел, нужен --refresh-profile", want, have };
}

const PRIVATE = ["messages/out", "messages/.cache", "messages/companies", "messages/jobs", "messages/notes.md", "messages/voice", "messages/resume-public.md", "messages/profile.md", "messages/candidate.json", "messages/rules/personal-data.local.txt"];

export function leaks() {
  const r = spawnSync("git", ["ls-files", "--", ...PRIVATE], { cwd: REPO, encoding: "utf8", windowsHide: true });
  const files = (r.stdout || "").trim().split("\n").filter(Boolean);
  return files.length ? `ВНИМАНИЕ: в git попали личные файлы: ${files.slice(0, 3).join(", ")}${files.length > 3 ? " и ещё " + (files.length - 3) : ""}` : "";
}

export function statusLine() {
  const sc = findScanner();
  const br = findBrowser();
  const cand = existsSync(CANDIDATE) ? (candidate().name ? "" : "candidate.json: не заполнено имя") : "нет messages/candidate.json";
  const parts = [today(), profileState().state, cand, sc.error ? `сканер: ${sc.error}` : "сканер ok", br ? `браузер: ${/msedge|edge/i.test(br) ? "edge" : "chrome"}` : "браузера нет", leaks()];
  return "status: " + parts.filter(Boolean).join(" | ");
}
