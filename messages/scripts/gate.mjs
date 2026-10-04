#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { MSG, RULES, PROFILE, read, runDir, parseDoc, parseKeyLines, findScanner, candidate } from "./lib.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dir = runDir(args[0]);
const letterFile = args[1] ? (isAbsolute(args[1]) ? args[1] : join(dir, args[1])) : join(dir, "letter.md");

// Первая строка «Вакансия: <ссылка>» нужна кандидату для навигации и в проверку не входит.
const raw = read(letterFile).trim().replace(/^(?:вакансия\s*:\s*)?https?:\/\/\S+[ \t]*(?:\n+|$)/iu, "").trim();
if (!raw) {
  console.log(`gate: red | нет текста в ${letterFile}`);
  process.exit(1);
}
const lines = raw.split("\n");
const subject = /^тема\s*:/i.test(lines[0]) ? lines.shift().replace(/^тема\s*:\s*/i, "") : "";
const body = lines.join("\n").trim();
const vac = parseDoc(read(join(dir, "vacancy.md")));
const head = vac.head;
const mxText = read(join(dir, "matrix.md"));
const mx = parseKeyLines(mxText);
const lower = raw.toLowerCase();

const hard = [];
const soft = [];
const quote = (text, i, len) => "«" + text.slice(Math.max(0, i - 30), i + len + 30).replace(/\s+/g, " ").trim() + "»";
const add = (list, check, detail, q) => list.push({ check, detail, ...(q ? { quote: q } : {}) });

const dashes = [...raw.matchAll(/[—–]/g)];
if (dashes.length) add(hard, "тире", `${dashes.length} шт., заменить запятой, двоеточием, точкой или дефисом`, dashes.slice(0, 2).map((m) => quote(raw, m.index, 1)).join(" "));

const NEG = [
  ["«не X, а Y»", /(?<!\p{L})не\s+[^.!?\n,;:]{1,60},\s*а(?!\p{L})/giu],
  ["«не только X, но и Y»", /(?<!\p{L})не\s+только\s+[^.!?\n]{1,80}?\s+но\s+и(?!\p{L})/giu],
];
for (const [name, re] of NEG) for (const m of raw.matchAll(re)) add(hard, "противопоставление " + name, "сказать прямо", quote(raw, m.index, m[0].length));

function loadRules(file) {
  return read(join(RULES, file))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [label, re, allow] = l.split(" | ");
      try {
        return { label, re: new RegExp("(?<![\\p{L}\\p{N}])(?:" + re + ")", "giu"), allow: allow ? new RegExp(allow, "iu") : null };
      } catch (e) {
        add(soft, "правило", `не разобрано в ${file}: ${label}: ${e.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

const letterCyr = (raw.match(/[а-яё]/gi) || []).length / Math.max(1, (raw.match(/\p{L}/gu) || []).length);
const russian = letterCyr >= 0.3;

if (russian)
  for (const r of loadRules("stamps.txt"))
    for (const m of raw.matchAll(r.re)) {
      add(hard, "штамп", r.label, quote(raw, m.index, m[0].length));
      break;
    }

const vacText = vac.body + "\n" + (head.asks || []).join("\n");
for (const r of [...loadRules("personal-data.txt"), ...loadRules("personal-data.local.txt")]) {
  if (r.allow && r.allow.test(vacText)) continue;
  const m = [...raw.matchAll(r.re)][0];
  if (m) add(hard, "личные данные", r.label + (r.allow ? " (вакансия об этом не просит)" : ""), quote(raw, m.index, m[0].length));
}

const prof = read(PROFILE)
  .split(/\n(?=## )/)
  .filter((sec) => !/^## Нельзя/.test(sec))
  .join("\n")
  .split("\n")
  .filter((l) => !/^\d+\.\s*todo\b/.test(l))
  .join("\n");
const cardPath = mx.card || head.company_card || "";
const sources = [prof, vac.body, JSON.stringify(head), read(join(MSG, "notes.md")), read(join(dir, "notes.md")), cardPath ? read(cardPath) : ""].join("\n");
const srcLower = sources.toLowerCase();

const NUM = /(?<![\p{L}\d.,])(\d+(?:[.,]\d+)?)(?:\s*(%|процент\p{L}*|k(?![a-z])|к(?!\p{L})|тыс\p{L}*\.?|млн\p{L}*\.?))?/giu;
const unit = (u = "") => (/^(%|процент)/i.test(u) ? "%" : /^(k|к|тыс)/i.test(u) ? "k" : /^млн/i.test(u) ? "m" : "");
const numbers = (text) => [...text.matchAll(NUM)].map((m) => ({ key: m[1].replace(",", ".") + unit(m[2]), at: m.index, len: m[0].length }));
const srcNums = new Set(numbers(sources).map((n) => n.key));
const badNums = new Map();
for (const n of numbers(raw)) if (!srcNums.has(n.key) && !badNums.has(n.key)) badNums.set(n.key, quote(raw, n.at, n.len));
for (const [k, q] of badNums) add(hard, "факт-замок", `число «${k}» нет ни в профиле (кроме todo), ни в заметках, ни в вакансии`, q);

const LAT = /[A-Za-z][A-Za-z0-9+#]*(?:[.\-/@_][A-Za-z0-9+#]+)*/g;
const latinOk = new Set(read(join(RULES, "latin-ok.txt")).split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean));
const srcTokens = new Set((sources.match(LAT) || []).map((t) => t.toLowerCase()));
const latinKnown = (t) => srcTokens.has(t) || latinOk.has(t) || (t.length >= 4 && srcLower.includes(t));
const badLat = new Map();
for (const m of raw.matchAll(LAT)) {
  const t = m[0].toLowerCase().replace(/[.\-_/]+$/, "");
  if (latinKnown(t) || t.split(/[/]/).every((p) => latinKnown(p))) continue;
  if (!badLat.has(t)) badLat.set(t, quote(raw, m.index, m[0].length));
}
for (const [t, q] of badLat) add(hard, "факт-замок", `«${t}» нет ни в профиле, ни в заметках, ни в вакансии`, q);

const cw = (mx.codeword || "").replace(/^[«"'“]|[»"'”]$/g, "").trim();
const hasCw = cw && !/^(-|нет|none)$/i.test(cw);
// Просьбы вакансии вставить слово или фразу (кодовое слово, обращение к ИИ) выполняются только с одобрения пользователя: строка approve_asks: в <run>/notes.md.
const approved = /^approve_asks:\s*\S/m.test(read(join(dir, "notes.md")));
const hint = head.codeword_hint && head.codeword_hint !== "?" ? head.codeword_hint : "";
if (!approved) {
  if (hasCw) add(hard, "ловушка", `кодовое слово «${cw}» без одобрения пользователя: убери его из письма и поставь в matrix.md codeword: -, просьбу вакансии занеси в report.md`);
  else if (hint && lower.includes(hint.toLowerCase())) add(hard, "ловушка", `в письме слово «${hint}» из просьбы вакансии, пользователь его не одобрял: убери`);
} else if (hasCw) {
  if (!lower.includes(cw.toLowerCase())) add(hard, "кодовое слово", `«${cw}» из matrix.md нет в письме`);
} else if (head.codeword_hint && !cw) {
  add(hard, "кодовое слово", `пользователь одобрил просьбы вакансии, а кодовое слово «${head.codeword_hint}» не внесено: впиши его в письмо и в matrix.md строкой codeword: ..., если это не кодовое слово, поставь codeword: -`);
}

if (head.channel === "email" && !subject) add(hard, "тема", `для email первая строка письма: «Тема: ${head.subject || "Отклик на вакансию <должность>, <имя и фамилия>"}»`);

// Приветствие и подпись отделяются от сути письма: длина в предложениях считается только по сути.
const GREET = /^(?:добрый|доброе|здравствуй|привет|hello|hi|dear|good\s+(?:morning|afternoon|day))(?!\p{L})[^\n.!?]*[.!?,]?\s*/iu;
const SIGNOFF = /^(?:с\s+уважением|всего\s+доброго|хорошего\s+дня|best\s+regards|kind\s+regards|regards)(?!\p{L})/iu;
const me = candidate();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = [...new Set([me.name, me.short].filter(Boolean))].map((n) => new RegExp("(?<!\\p{L})" + esc(n) + "(?!\\p{L})", "iu"));
const signHead = String(head.sign || "").split(",")[0].trim();
const greeting = (body.match(GREET) || [""])[0];
const tail = body.slice(greeting.length).split("\n");
const signLines = [];
while (tail.length > 1 && signLines.length < 2) {
  const l = tail[tail.length - 1].trim();
  if (!l) {
    tail.pop();
    continue;
  }
  const isSign = SIGNOFF.test(l) || (signHead && l.startsWith(signHead)) || (names.some((re) => re.test(l)) && !/[.!?]$/.test(l) && l.split(/\s+/).length <= 8);
  if (!isSign) break;
  signLines.unshift(tail.pop().trim());
}
const core = tail.join("\n").trim();

const WORD = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
const countWords = (t) => (t.match(WORD) || []).length;
const sentences = core
  .split(/\n+/)
  .flatMap((l) => l.split(/(?<=[.!?…])\s+/))
  .map((s) => s.trim())
  .filter((s) => /\p{L}/u.test(s));
const asksListed = /^employer_asks:[^\n]*\n\s*-\s+(?!-\s*$)\S/m.test(mxText);
const extra = approved && (asksListed || hasCw) ? 1 : 0;
if (sentences.length > 4 + extra)
  add(hard, "длина", `${sentences.length} предложений при норме 3-4${extra ? " (с ответом на просьбу работодателя до 5)" : ""}: оставь пользу, адаптацию и ответ на просьбы, остальное убери`);
else if (sentences.length < 2) add(soft, "длина", "меньше двух предложений: письмо не отвечает на два вопроса, чем полезен и как быстро закроет пробел");
for (const s of sentences) if (countWords(s) > 30) add(soft, "длинное предложение", `${countWords(s)} слов: раздели или сократи`, "«" + s.slice(0, 80) + "…»");

const [minW, maxW] = String(head.words || "30-70").split("-").map(Number);
const words = countWords(body);
if (words > maxW * 1.3) add(hard, "длина", `${words} слов при норме ${minW}-${maxW}`);
else if (words > maxW || words < minW) add(soft, "длина", `${words} слов при норме ${minW}-${maxW}`);

// Стек лежит в резюме: три и больше названия подряд через запятую, «и», «/» или «+» это перечисление.
const ITEM = String.raw`[A-Za-z][A-Za-z0-9+#]*(?:[.\-@_][A-Za-z0-9+#]+)*(?:\s+(?:\d+(?:[./]\d+)*|[A-Z][A-Za-z0-9+#]*(?:[.\-][A-Za-z0-9+#]+)*))*`;
const SEP = String.raw`\s*[,+/]\s*|\s+(?:и|или|and|or)\s+`;
const LIST = new RegExp(`${ITEM}(?:(?:${SEP})${ITEM}){2,}`, "gu");
const listText = core
  .replace(/https?:\/\/\S+|(?<![\p{L}\d])[\w-]+\.(?:ru|com|io|dev|org|net|app|me|pro|tech)\/\S*/giu, (u) => " ".repeat(u.length))
  .replace(/(?<![A-Za-z])([A-Z]{1,3})\/([A-Z]{1,3})(?![A-Za-z])/g, "$1_$2");
for (const m of listText.matchAll(LIST)) {
  const n = (m[0].match(new RegExp(ITEM, "gu")) || []).filter((t) => !/^(and|or)$/i.test(t)).length;
  if (n >= 3) add(hard, "перечисление стека", `названий подряд: ${n}, резюме рядом, оставь 1-2 главных для этой вакансии`, quote(core, m.index, m[0].length));
}

if (head.board) {
  const nameAt = names.map((re) => body.match(re)).find(Boolean);
  if (signLines.length || nameAt)
    add(hard, "подпись на площадке", "рекрутер видит имя и резюме в отклике: без подписи, представления и прощания", signLines.length ? "«" + signLines.join(" ") + "»" : quote(body, nameAt.index, nameAt[0].length));
  const first = (sentences[0] || "").split(/(?<=:)\s/)[0];
  const m = first.match(/откликаюсь|откликнуться|отклик\s+на|претендую|рассматриваю\s+(ваш\p{L}*\s+)?(позици|ваканси)|интерес\p{L}*\s+(ваш\p{L}*\s+)?(позици|ваканси)|по\s+поводу\s+ваканси|на\s+ваш\p{L}*\s+ваканси/iu);
  if (m) add(hard, "должность в первой фразе", "письмо уходит внутри отклика на площадке, вакансию рекрутер уже видит: начни сразу с главной причины, почему подходишь", quote(first, m.index, m[0].length));
}

// Названий нет: работодатель это «вы», «у вас», «в вашем проекте», прошлый опыт описывается делом без мест работы и проектов.
const GENERIC = /^(the|and|group|international|mobile|company|studio|группа|компания|студия|веб-студия|банк|маркет|market)$/iu;
const nameRe = (name, skip = "") => {
  const clean = name.toLowerCase().replace(/[«»"“”']/g, " ").replace(/(?<!\p{L})(ооо|ао|пао|зао|ип|llc|inc|ltd)(?!\p{L})/giu, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 2) return null;
  const alts = [esc(clean)];
  const word = clean.split(/[\s.,()]+/).find((w) => w.length >= 4 && !GENERIC.test(w) && !skip.includes(w.slice(0, 5)));
  if (word) alts.push(/^[a-z]/.test(word) ? esc(word) + "(?![a-z])" : esc(word.slice(0, word.length <= 5 ? -1 : -2)) + "\\p{L}{0,3}(?!\\p{L})");
  return new RegExp("(?<![\\p{L}\\p{N}])(?:" + alts.join("|") + ")", "iu");
};
for (const c of new Set([mx.company, head.company].filter((c) => c && c !== "-"))) {
  const m = raw.match(nameRe(c) || /$^/);
  if (m) {
    add(hard, "название компании", "компанию не называй: «у вас», «в вашем проекте», «ваша команда»", quote(raw, m.index, m[0].length));
    break;
  }
}
const places = [...read(PROFILE).matchAll(/^- \d{4}-\d{2} - \S+ (.+?)(?:\s*\(([^)]*)\))?:\s/gm)].map(([, place, sector = ""]) => nameRe(place, sector.toLowerCase())).filter(Boolean);
for (const re of places) {
  const m = raw.match(re);
  if (m) add(hard, "место работы", "не называй компании и проекты, где был опыт: опиши, что делал", quote(raw, m.index, m[0].length));
}
const ownLinks = Object.values(me.links || {}).filter(Boolean).map((l) => l.toLowerCase());
for (const m of raw.matchAll(/(?<![\p{L}\p{N}@.\/])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ru|рф|com|net|org|io|app|dev|pro|tech|me|su|kz|by|uz|ua)(?![\p{L}\p{N}])/giu)) {
  if (ownLinks.some((l) => l.includes(m[0].toLowerCase())) || places.some((re) => re.test(m[0]))) continue;
  add(hard, "название проекта", "адрес сайта это название проекта: опиши, что делал, без адреса", quote(raw, m.index, m[0].length));
}

const terms = (mx.key_terms || "").split(/;/).map((s) => s.trim()).filter(Boolean);
const termHit = (t) =>
  (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).every((w) => w.length < 3 || lower.includes(w.slice(0, Math.max(3, Math.ceil(w.length * 0.75)))));
const hitTerms = terms.filter(termHit);
if (!terms.length) add(soft, "key_terms", "в matrix.md нет строки key_terms: покрытие не посчитано");
else if (hitTerms.length < Math.min(2, terms.length))
  add(soft, "key_terms", `${hitTerms.length} из ${terms.length}; нет: ${terms.filter((t) => !termHit(t)).slice(0, 6).join(", ")}`);

const tone = (mx.tone || "вы").toLowerCase();
if (tone.startsWith("вы") && /(?<!\p{L})(ты|тебя|тебе|тобой|твой|твоя|твои|твоё|твоего|твоей|твоих)(?!\p{L})/iu.test(body)) add(soft, "тон", "вакансия на «вы», в письме есть «ты»");
if (tone.startsWith("ты") && /(?<!\p{L})(вы|вас|вам|вами|ваш\p{L}*)(?!\p{L})/iu.test(body)) add(soft, "тон", "вакансия на «ты», в письме есть «вы»");
// Неформальное приветствие вместо «Здравствуйте.»: только если кандидат задал informal_greeting в notes.md и вакансия на «ты».
const informalOk = tone.startsWith("ты") && /^informal_greeting:\s*\S/m.test(read(join(MSG, "notes.md"))) && /^(?:привет|хай|здорово|здарова)(?!\p{L})[^\n]{0,40}[.!?](?:\s|$)/iu.test(body.trim());
if (russian && !informalOk && !/^Здравствуйте\.(?:\s|$)/.test(body.trim())) add(hard, "приветствие", "письмо на русском всегда начинается с отдельного «Здравствуйте.» (с точкой, без имени и других слов)");

const scan = { status: "skipped" };
const sc = findScanner();
if (!russian) scan.status = "английский текст, сканер не нужен";
else if (sc.error) {
  scan.status = "unavailable: " + sc.error;
  add(soft, "сканер", scan.status);
} else {
  const r = spawnSync(sc.py, [sc.scan, "-", "--json"], { input: body, encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, windowsHide: true, timeout: 90000 });
  try {
    const j = JSON.parse(r.stdout);
    for (const [marker, count] of j.hard_bans || []) if (marker !== "Длинное тире") add(hard, "сканер", `${marker} ×${count}`);
    const stems = terms.join(" ").toLowerCase();
    const markers = (j.markers || []).filter(([cat]) => cat !== "Артефакты копипасты");
    const white = markers.filter(([, stem]) => stems.includes(String(stem).toLowerCase()));
    const whiteCount = white.reduce((s, [, , c]) => s + c, 0);
    const softCount = markers.reduce((s, [, , c]) => s + c, 0) - whiteCount;
    const w = j.rhythm?.words || words || 1;
    const pens = (j.score?.penalties || []).filter((p) => !/^(ровный ритм|ровные абзацы|маркеры)/.test(p.reason));
    const markerPen = softCount ? Math.min(30, Math.round((2 * softCount * 100) / w)) : 0;
    const adjusted = Math.max(0, Math.min(100, 100 + pens.reduce((s, p) => s + p.points, 0) - markerPen));
    Object.assign(scan, { status: "ok", raw: j.score?.score, adjusted, whitelisted: whiteCount });
    const left = markers.filter((m) => !white.includes(m)).map(([cat, stem, c]) => `${cat.toLowerCase()} «${stem}»${c > 1 ? " ×" + c : ""}`);
    if (adjusted < 85) add(soft, "сканер", `чистота ${adjusted}/100${left.length ? ": " + left.slice(0, 5).join(", ") : ""}${pens.length ? "; " + pens.map((p) => p.reason).join(", ") : ""}`);
  } catch (e) {
    scan.status = "error: " + (r.stderr || e.message).trim().split("\n").pop();
    add(soft, "сканер", scan.status);
  }
}

const green = hard.length === 0;
const result = { gate: green ? "green" : "red", file: letterFile, words, limits: [minW, maxW], hard, soft, scanner: scan, key_terms: { total: terms.length, hit: hitTerms.length } };
writeFileSync(join(dir, "gate.json"), JSON.stringify(result, null, 2));

const scanText = scan.status === "ok" ? ` | чистота ${scan.adjusted}${scan.whitelisted ? ` (сырая ${scan.raw}, по key_terms вычтено ${scan.whitelisted})` : ""}` : "";
console.log(`gate: ${result.gate} | hard ${hard.length} | soft ${soft.length} | слов ${words} (норма ${minW}-${maxW}) | key_terms ${hitTerms.length}/${terms.length}${scanText}`);
for (const [kind, list] of [["hard", hard], ["soft", soft]]) for (const i of list) console.log(`${kind} | ${i.check} | ${i.detail}${i.quote ? " | " + i.quote : ""}`);
process.exit(green ? 0 : 1);
