import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { basename, extname, resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { OUT, CACHE, COMPANIES, JOBS, PARSERS_DIR, fwd, read, ageDays, parseDoc, slugify, findBrowser } from "./lib.mjs";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
export const settings = { refetch: false, reparse: false, browser: false };
mkdirSync(join(CACHE, "pages"), { recursive: true });

export class NetError extends Error {}

export const ent = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&amp;/g, "&");

export const htmlText = (s) =>
  ent(
    String(s || "")
      .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|section|article|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const meta = (html, name) => {
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`, "i")) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, "i"));
  return m ? htmlText(m[1]) : "";
};

export function ldJobPosting(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const jp = (Array.isArray(j) ? j : j["@graph"] || [j]).find((x) => x && [].concat(x["@type"]).includes("JobPosting"));
      if (jp) return jp;
    } catch {}
  }
  return null;
}

export function fromJobPosting(jp) {
  const sal = jp.baseSalary?.value;
  let salary = "";
  if (sal && (sal.minValue || sal.maxValue || sal.value)) {
    const cur = jp.baseSalary.currency || sal.currency || "";
    salary = [sal.minValue && `от ${sal.minValue}`, sal.maxValue && `до ${sal.maxValue}`, sal.value].filter(Boolean).join(" ") + (cur ? " " + cur : "");
  }
  const a = [].concat(jp.jobLocation || [])[0]?.address;
  return {
    title: htmlText(jp.title || ""),
    company: htmlText(jp.hiringOrganization?.name || ""),
    salary,
    location: a ? [a.addressLocality, a.streetAddress].filter(Boolean).join(", ") : "",
    employment: [].concat(jp.employmentType || []).join(", "),
    work_format: jp.jobLocationType === "TELECOMMUTE" ? "удалённо" : "",
    date_posted: String(jp.datePosted || "").slice(0, 10),
    text: htmlText(jp.description || ""),
  };
}

export function balanced(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return "";
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return "";
}

const tryJson = (raw) => {
  for (const s of [raw, ent(raw)]) {
    try {
      return JSON.parse(s.trim());
    } catch {}
  }
  return undefined;
};

class Lit {
  constructor(src) {
    this.s = src;
    this.i = 0;
  }
  ws() {
    for (;;) {
      const r = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*)/.exec(this.s.slice(this.i, this.i + 4096));
      if (!r || !r[0].length) return;
      this.i += r[0].length;
    }
  }
  peek() {
    this.ws();
    return this.s[this.i];
  }
  eat(ch) {
    if (this.peek() !== ch) throw new Error(`ожидался «${ch}» на ${this.i}`);
    this.i++;
  }
  word(w) {
    this.ws();
    if (this.s.startsWith(w, this.i) && !/[\w$]/.test(this.s[this.i + w.length] || "")) {
      this.i += w.length;
      return true;
    }
    return false;
  }
  ident() {
    this.ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) throw new Error(`ожидался идентификатор на ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  str() {
    const q = this.s[this.i++];
    let out = "";
    for (;;) {
      const ch = this.s[this.i++];
      if (ch === undefined) throw new Error("строка не закрыта");
      if (ch === q) return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const e = this.s[this.i++];
      if (e === "u") {
        if (this.s[this.i] === "{") {
          const end = this.s.indexOf("}", this.i);
          out += String.fromCodePoint(parseInt(this.s.slice(this.i + 1, end), 16));
          this.i = end + 1;
        } else {
          out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16));
          this.i += 4;
        }
      } else if (e === "x") {
        out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16));
        this.i += 2;
      } else if (e === "\n") continue;
      else out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" }[e] ?? e;
    }
  }
  num() {
    const m = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) throw new Error(`ожидалось число на ${this.i}`);
    this.i += m[0].length;
    return Number(m[0]);
  }
  expr() {
    const c = this.peek();
    if (c === "{") {
      this.i++;
      const props = [];
      while (this.peek() !== "}") {
        const k = this.peek();
        const key = k === '"' || k === "'" ? this.str() : /[\d.]/.test(k) ? String(this.num()) : this.ident();
        this.eat(":");
        props.push([key, this.expr()]);
        if (this.peek() === ",") this.i++;
      }
      this.i++;
      return { t: "obj", props };
    }
    if (c === "[") {
      this.i++;
      const items = [];
      while (this.peek() !== "]") {
        if (this.peek() === ",") {
          this.i++;
          items.push(null);
          continue;
        }
        items.push(this.expr());
        if (this.peek() === ",") this.i++;
      }
      this.i++;
      return { t: "arr", items };
    }
    if (c === '"' || c === "'") return { t: "lit", v: this.str() };
    if (c === "!") {
      this.i++;
      return { t: "not", e: this.expr() };
    }
    if (c === "-" || c === "+") {
      this.i++;
      return { t: c === "-" ? "neg" : "pos", e: this.expr() };
    }
    if (/[\d.]/.test(c || "")) return { t: "lit", v: this.num() };
    if (this.word("void")) {
      this.expr();
      return { t: "lit", v: undefined };
    }
    const isNew = this.word("new");
    const id = this.ident();
    const KW = { true: true, false: false, null: null, undefined: undefined, NaN: NaN, Infinity: Infinity };
    let node = !isNew && id in KW ? { t: "lit", v: KW[id] } : { t: "id", n: id };
    for (;;) {
      const p = this.peek();
      if (p === ".") {
        this.i++;
        node = { t: "mem", o: node, k: { t: "lit", v: this.ident() } };
      } else if (p === "[") {
        this.i++;
        const k = this.expr();
        this.eat("]");
        node = { t: "mem", o: node, k };
      } else if (p === "(") {
        this.i++;
        const args = [];
        while (this.peek() !== ")") {
          args.push(this.expr());
          if (this.peek() === ",") this.i++;
        }
        this.i++;
        node = { t: "call", f: node, args };
      } else return node;
    }
  }
}

function litEval(n, env) {
  if (!n) return undefined;
  switch (n.t) {
    case "lit":
      return n.v;
    case "id":
      return Object.prototype.hasOwnProperty.call(env, n.n) ? env[n.n] : undefined;
    case "obj": {
      const o = {};
      for (const [k, v] of n.props) if (k !== "__proto__") o[k] = litEval(v, env);
      return o;
    }
    case "arr":
      return n.items.map((x) => (x ? litEval(x, env) : undefined));
    case "not":
      return !litEval(n.e, env);
    case "neg":
      return -litEval(n.e, env);
    case "pos":
      return +litEval(n.e, env);
    case "mem": {
      const o = litEval(n.o, env);
      const k = litEval(n.k, env);
      return o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
    }
    case "call": {
      const f = n.f.t === "id" ? n.f.n : "";
      const a = n.args.map((x) => litEval(x, env));
      if (f === "Date") return typeof a[0] === "number" ? new Date(a[0]).toISOString() : a[0];
      if (f === "Array") return a.length === 1 && typeof a[0] === "number" ? new Array(a[0]).fill(undefined) : a;
      return undefined;
    }
  }
  return undefined;
}

function nuxt2State(html) {
  const m = /window\.__NUXT__\s*=\s*/.exec(html);
  if (!m) return undefined;
  const p = new Lit(html.slice(m.index + m[0].length));
  try {
    if (p.peek() !== "(") return litEval(p.expr(), {});
    p.i++;
    if (!p.word("function")) return undefined;
    p.eat("(");
    const params = [];
    while (p.peek() !== ")") {
      params.push(p.ident());
      if (p.peek() === ",") p.i++;
    }
    p.i++;
    p.eat("{");
    const assigns = [];
    let ret = null;
    while (p.peek() !== "}") {
      if (p.word("return")) {
        ret = p.expr();
        if (p.peek() === ";") p.i++;
        continue;
      }
      const target = p.expr();
      p.eat("=");
      assigns.push([target, p.expr()]);
      if (p.peek() === ";" || p.peek() === ",") p.i++;
    }
    p.i++;
    if (p.peek() === ")") p.i++;
    p.eat("(");
    const args = [];
    while (p.peek() !== ")") {
      args.push(litEval(p.expr(), {}));
      if (p.peek() === ",") p.i++;
    }
    const env = Object.create(null);
    params.forEach((name, k) => (env[name] = args[k]));
    for (const [t, v] of assigns) {
      if (t.t !== "mem") continue;
      const o = litEval(t.o, env);
      const k = litEval(t.k, env);
      if (o && typeof o === "object" && k !== "__proto__") o[k] = litEval(v, env);
    }
    return litEval(ret, env);
  } catch {
    return undefined;
  }
}

export function devalue(values) {
  if (!Array.isArray(values)) return values;
  const done = new Map();
  const SPECIAL = { "-1": undefined, "-3": NaN, "-4": Infinity, "-5": -Infinity, "-6": -0 };
  const h = (i) => {
    if (i < 0) return SPECIAL[i];
    if (done.has(i)) return done.get(i);
    const v = values[i];
    if (!v || typeof v !== "object") {
      done.set(i, v);
      return v;
    }
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") {
        const [type, ...rest] = v;
        if (type === "Date" || type === "RegExp" || type === "BigInt" || type === "URL") return rest[0];
        if (type === "Set") return rest.map(h);
        if (type === "Map" || type === "null") {
          const o = {};
          done.set(i, o);
          for (let k = 0; k < rest.length; k += 2) o[String(h(rest[k]))] = h(rest[k + 1]);
          return o;
        }
        return typeof rest[0] === "number" ? h(rest[0]) : rest[0];
      }
      const arr = [];
      done.set(i, arr);
      for (const n of v) arr.push(n === -2 ? undefined : h(n));
      return arr;
    }
    const o = {};
    done.set(i, o);
    for (const [k, n] of Object.entries(v)) if (k !== "__proto__") o[k] = typeof n === "number" ? h(n) : n;
    return o;
  };
  return h(0);
}

export function nuxtState(html) {
  const n2 = nuxt2State(html);
  if (n2 !== undefined) return n2;
  const m = html.match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return undefined;
  try {
    return devalue(JSON.parse(m[1]));
  } catch {
    return undefined;
  }
}

export function jsonBlobs(html) {
  const out = [];
  const add = (kind, raw, data) => out.push({ index: out.length, kind, size: typeof raw === "number" ? raw : raw.length, data });
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const body = m[2];
    if (!body.trim()) continue;
    const type = (attrs.match(/type=["']([^"']+)/i) || [])[1] || "";
    const id = (attrs.match(/\bid=["']([^"']+)/i) || [])[1] || "";
    const kind = ["script", id && "#" + id, type && "type=" + type].filter(Boolean).join(" ");
    if (/json/i.test(type) || /data-[\w-]*state/i.test(attrs)) {
      const data = tryJson(body);
      if (data !== undefined) add(kind, body, data);
      continue;
    }
    for (const a of body.matchAll(/(window\.[\w$]+|window\[["'][\w$]+["']\]|(?:var|let|const)\s+(?:__[\w$]*|[\w$]*(?:[Ss]tate|[Dd]ata|[Pp]rops|INITIAL|PRELOADED)[\w$]*))\s*=\s*(?=[{[])/g)) {
      const raw = balanced(body, a.index + a[0].length);
      if (raw.length < 50) continue;
      const data = tryJson(raw);
      if (data !== undefined) add(`${kind} ${a[1].replace(/\s+/g, " ")}`, raw, data);
    }
    for (const a of body.matchAll(/JSON\.parse\((["'`])/g)) {
      const q = a[1];
      let i = a.index + a[0].length;
      let s = "";
      for (; i < body.length && body[i] !== q; i++) s += body[i] === "\\" ? body[i] + body[++i] : body[i];
      try {
        const data = JSON.parse(JSON.parse(q === '"' ? `"${s}"` : `"${s.replace(/"/g, '\\"')}"`));
        if (s.length >= 50) add(`${kind} JSON.parse`, s, data);
      } catch {}
    }
  }
  for (const m of html.matchAll(/<template\b([^>]*)>([\s\S]*?)<\/template>/gi)) {
    const id = (m[1].match(/\bid=["']([^"']+)/i) || [])[1] || "";
    const data = tryJson(m[2]);
    if (data !== undefined && typeof data === "object") add(`template${id ? " #" + id : ""}`, m[2], data);
  }
  const n2 = nuxt2State(html);
  if (n2 !== undefined) add("nuxt2 window.__NUXT__, kit.nuxtState(html)", (/window\.__NUXT__[\s\S]*?<\/script>/.exec(html) || [""])[0].length, n2);
  const n3 = out.find((b) => /__NUXT_DATA__/.test(b.kind) && Array.isArray(b.data));
  if (n3) add("nuxt3 __NUXT_DATA__ развёрнутый, kit.nuxtState(html)", n3.size, devalue(n3.data));
  return out;
}

const lastHit = new Map();
export const blockedHosts = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const cacheFile = (key) => join(CACHE, "pages", createHash("sha1").update(key).digest("hex") + ".html");

export const isBlocked = (html, status) => {
  if (status === 403 || status === 429) return true;
  const head = html.slice(0, 30000);
  if (/<title>[^<]*(captcha|капча|доступ ограничен|access denied|just a moment|forbidden)/i.test(head)) return true;
  if (/showcaptcha|smartcaptcha|cf-challenge|challenge-platform/i.test(head)) return htmlText(html).length < 3000;
  return false;
};

async function httpGet(url, maxAgeDays = 7, headers = {}) {
  const cf = cacheFile(url);
  if (!settings.refetch && ageDays(cf) < maxAgeDays) return { html: read(cf), status: 200, cached: true };
  const host = new URL(url).hostname;
  const wait = 1500 - (Date.now() - (lastHit.get(host) || 0));
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  let r;
  try {
    r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8", Accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const code = e.cause?.code || e.code || "";
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(code + " " + e.message))
      throw new NetError("сайт подписан сертификатом, которому система не доверяет (часто это корневой сертификат Минцифры): поставьте сертификат и укажите его в NODE_EXTRA_CA_CERTS или вставьте текст вручную");
    throw new NetError("сеть: " + (e.name === "TimeoutError" ? "таймаут 25 с" : e.message));
  }
  const html = await r.text();
  if (r.ok && !isBlocked(html, r.status)) writeFileSync(cf, html);
  return { html, status: r.status, cached: false };
}

export function renderDom(url) {
  const browser = findBrowser();
  if (!browser) throw new NetError("браузер для запасного пути не найден (Chrome или Edge)");
  const cf = cacheFile("dom:" + url);
  if (!settings.refetch && ageDays(cf) < 7) return read(cf);
  const run = (profile) =>
    spawnSync(
      browser,
      ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--mute-audio", `--user-data-dir=${profile}`, `--user-agent=${UA}`, "--lang=ru-RU", "--virtual-time-budget=10000", "--dump-dom", url],
      { encoding: "utf8", timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true }
    );
  let r = run(join(CACHE, "browser-profile"));
  if ((r.stdout || "").length < 500) r = run(join(CACHE, "browser-profiles", String(process.pid)));
  const html = r.stdout || "";
  if (html.length < 500) throw new NetError("браузер не отдал страницу" + (r.error ? ": " + r.error.message : ""));
  if (!isBlocked(html, 200)) writeFileSync(cf, html);
  return html;
}

export async function page(url, { allowBrowser = true, maxAgeDays = 7, headers = {} } = {}) {
  const host = new URL(url).hostname;
  if (blockedHosts.has(host)) throw new NetError(`${host} уже отказал в этом прогоне (${blockedHosts.get(host)}), ссылка пропущена`);
  if (settings.browser && allowBrowser) return { html: renderDom(url), via: "browser" };
  const r = await httpGet(url, maxAgeDays, headers);
  if (!isBlocked(r.html, r.status) && r.status < 400) return { html: r.html, via: r.cached ? "cache" : "http" };
  if (r.status === 404 || r.status === 410) throw new NetError(`страница не найдена (${r.status}): вакансию сняли или ссылка неверна`);
  const why = r.status === 429 ? "429, слишком много запросов с этого IP" : r.status >= 400 && r.status !== 403 ? `статус ${r.status}` : "антибот или капча";
  if (allowBrowser && r.status !== 429 && r.status < 500) {
    try {
      const html = renderDom(url);
      if (!isBlocked(html, 200)) return { html, via: "browser" };
    } catch {}
  }
  blockedHosts.set(host, why);
  throw new NetError(`${host}: ${why}`);
}

export async function json(url, opt = {}) {
  const { html, via } = await page(url, { allowBrowser: false, ...opt, headers: { Accept: "application/json", ...(opt.headers || {}) } });
  try {
    return { data: JSON.parse(html), via };
  } catch {
    throw new Error(`${url}: ответ не JSON`);
  }
}

export function mainText(html) {
  const body = html.replace(/<(script|style|noscript|svg|nav|header|footer|template|form)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const main = body.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i);
  let text = main ? htmlText(main[2]) : "";
  let method = "main";
  if (text.length < 400) {
    const chunks = body
      .split(/<\/?(?:div|section|article|main|td)[^>]*>/i)
      .map(htmlText)
      .filter((c) => c.length > 40)
      .sort((a, b) => b.length - a.length);
    if (chunks[0]?.length > 400) {
      text = chunks[0];
      method = "largest-block";
    } else {
      text = htmlText(body);
      method = "whole-body";
    }
  }
  return { text, method };
}

export async function extractSite(url) {
  let { html, via } = await page(url);
  let jp = ldJobPosting(html);
  let got = jp ? null : mainText(html);
  if (!jp && got.text.length < 300 && via !== "browser") {
    try {
      html = renderDom(url);
      via = "browser";
      jp = ldJobPosting(html);
      got = jp ? null : mainText(html);
    } catch {}
  }
  if (jp) return { ...fromJobPosting(jp), method: "ld+json/" + via };
  if (got.text.length < 200) throw new Error(`на странице почти нет текста (${got.text.length} симв.), браузер тоже не помог`);
  return { title: meta(html, "og:title") || htmlText((html.match(/<title[^>]*>([^<]*)/i) || [, ""])[1]), company: meta(html, "og:site_name"), text: got.text, method: got.method + "/" + via };
}

function readZipEntry(buf, name) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  for (let p = cdOff; p < cdOff + cdSize; ) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nlen) === name) {
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(start, start + csize);
      return method === 8 ? inflateRawSync(data) : data;
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

export function extractFile(f) {
  if (!existsSync(f)) throw new Error("файл не найден: " + fwd(f));
  const ext = extname(f).toLowerCase();
  let text;
  if (ext === ".pdf") {
    try {
      text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", f, "-"], { maxBuffer: 64e6, windowsHide: true }).toString("utf8");
    } catch {
      throw new Error("pdf: нет pdftotext или файл не читается");
    }
  } else if (ext === ".docx") {
    const x = readZipEntry(readFileSync(f), "word/document.xml");
    if (!x) throw new Error("docx: нет word/document.xml");
    text = htmlText(x.toString("utf8").replace(/<\/w:p>/g, "\n").replace(/<w:br\/>/g, "\n").replace(/<w:tab\/>/g, "\t"));
  } else if (ext === ".html" || ext === ".htm") {
    const html = read(f);
    const jp = ldJobPosting(html);
    if (jp) return { ...fromJobPosting(jp), method: "file ld+json" };
    const got = mainText(html);
    return { title: basename(f), company: "", text: got.text, method: "file " + got.method };
  } else text = read(f);
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("файл пустой");
  return { title: text.split("\n").find((l) => l.trim()).slice(0, 90), company: "", text, method: "file" + ext };
}

async function follow(url, from = "") {
  let s;
  try {
    s = classify(url);
  } catch {
    return null;
  }
  if (s.kind !== "parser" || s.parser === from) return null;
  const v = await extract(s);
  return { ...v, original: s.url, original_slug: s.slug, original_parser: s.parser, original_channel: s.channel };
}

export const kit = { page, json, htmlText, ent, meta, ldJobPosting, fromJobPosting, jsonBlobs, nuxtState, devalue, balanced, mainText, renderDom, follow, NetError };

export const parserErrors = [];
const UNSAFE = /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|["'](?:node:)?(?:vm|child_process|fs|fs\/promises|net|worker_threads)["']|\bBun\.(?:spawn|write|file|\$)|\bprocess\.(?:env|exit|kill)|\bimport\s*\(|\brequire\s*\(/;
async function loadParsers() {
  if (!existsSync(PARSERS_DIR)) return [];
  const list = [];
  for (const f of readdirSync(PARSERS_DIR).filter((x) => x.endsWith(".mjs") && !x.startsWith("_")).sort()) {
    const code = read(join(PARSERS_DIR, f));
    const bad = code.match(UNSAFE);
    if (bad) {
      parserErrors.push(`${f}: запрещённая конструкция «${bad[0]}»: код со страницы не выполняем, к файлам и процессам парсер не обращается`);
      continue;
    }
    try {
      const m = await import(pathToFileURL(join(PARSERS_DIR, f)).href);
      if (typeof m.match !== "function" || typeof m.extract !== "function") {
        parserErrors.push(`${f}: нет функций match и extract`);
        continue;
      }
      list.push({ name: m.name || basename(f, ".mjs"), channel: m.channel || "board", hosts: m.hosts || [], match: m.match, extract: m.extract, search: typeof m.search === "function" ? m.search : null, file: fwd(join(PARSERS_DIR, f)) });
    } catch (e) {
      parserErrors.push(`${f}: ${e.message}`);
    }
  }
  return list;
}
export const PARSERS = await loadParsers();

const BOARDS = /(^|\.)(superjob\.ru|rabota\.ru|zarplata\.ru|avito\.ru|trudvsem\.ru|geekjob\.ru|getmatch\.ru|careerspace\.app|linkedin\.com|djinni\.co|remote-job\.ru|finder\.work|hirehi\.ru|budu\.jobs|jobs\.tut\.by|rabota\.by|hh\.uz|headhunter\.ge|work\.ua|robota\.ua|indeed\.com|glassdoor\.com|wellfound\.com)$/i;

export function classify(raw) {
  let src = raw.trim();
  let forced = "";
  const cm = src.match(/#(?:channel=)?(email|form|telegram|hh|habr_career|board|site)$/i);
  if (cm) {
    forced = cm[1].toLowerCase();
    src = src.slice(0, cm.index);
  }
  if (/^(www\.)?([a-z0-9-]+\.)+[a-z]{2,}\//i.test(src)) src = "https://" + src;
  if (!/^https?:\/\//i.test(src)) {
    const f = isAbsolute(src) ? src : resolve(src);
    const parts = relative(OUT, f).split(/[\\/]/);
    if (parts.length === 2 && parts[1] === "vacancy.md" && parts[0] !== "..") return { kind: "run", slug: parts[0], channel: "", forced, source: raw };
    if (!relative(JOBS, f).startsWith("..") && existsSync(f)) {
      const url = parseDoc(read(f)).head.url;
      if (url) return { ...classify(url + (forced ? "#" + forced : "")), source: raw };
    }
    return { kind: "file", file: f, slug: "file-" + slugify(basename(f, extname(f)), 40), channel: "file", forced, source: raw };
  }
  const u = new URL(src);
  const host = u.hostname.replace(/^www\./, "");
  const site = siteSlug(u);
  for (const p of PARSERS) {
    let m = null;
    try {
      m = p.match(new URL(u));
    } catch (e) {
      m = { error: `парсер ${p.name}: match упал: ${e.message}` };
    }
    if (!m) continue;
    if (m.error) return { kind: "bad", parser: p.name, host, slug: m.slug || `${p.name}-link`, channel: p.channel, forced, error: m.error, source: raw };
    return { kind: "parser", parser: p.name, host, id: m.id, url: m.url || u.toString(), slug: m.slug || `${p.name}-${slugify(String(m.id), 40)}`, legacy: site.slug, channel: p.channel, forced, source: raw };
  }
  return { kind: "site", parser: "", host, url: site.url, slug: site.slug, channel: BOARDS.test(host) ? "board" : "site", forced, source: raw };
}

function siteSlug(url) {
  const u = new URL(url);
  u.hash = "";
  const canon = u.toString();
  const tail = createHash("sha1").update(canon).digest("hex").slice(0, 6);
  return { url: canon, slug: `site-${slugify(u.hostname.replace(/^www\./, "") + u.pathname, 40)}-${tail}` };
}

export async function extract(s) {
  if (s.kind === "bad") throw new Error(s.error);
  if (s.kind === "file") return { ...extractFile(s.file), parser: "file" };
  if (s.kind === "parser") {
    const p = PARSERS.find((x) => x.name === s.parser);
    try {
      const v = await p.extract(s, kit);
      if (!v || !String(v.text || "").trim()) throw new Error("парсер вернул пустой текст вакансии");
      return v.original_parser ? { ...v, parser: v.original_parser, found_via: p.name } : { ...v, parser: p.name };
    } catch (e) {
      if (e instanceof NetError) throw e;
      const err = new Error(`парсер ${p.name} сломался: ${e.message}`);
      err.brokenParser = p.name;
      throw err;
    }
  }
  try {
    return { ...(await extractSite(s.url)), parser: "" };
  } catch (e) {
    if (!(e instanceof NetError)) e.needParser = true;
    throw e;
  }
}

export function quality(v) {
  const len = String(v.text || "").length;
  const loose = /whole-body|largest-block/.test(v.method || "");
  const structured = !!v.parser || /ld\+json/.test(v.method || "");
  if (structured && !loose && len >= 600 && v.title && v.company) return "full";
  if (len >= 300 && v.title && !/whole-body/.test(v.method || "")) return "partial";
  return "poor";
}

const QUOTED = /[«"“„']([^«»"“”„']{2,40})[»"”']/u;
export function hints(v) {
  const text = v.text || "";
  const letters = text.match(/\p{L}/gu) || [];
  const cyr = letters.filter((c) => /[а-яё]/i.test(c)).length;
  const out = { lang: letters.length && cyr / letters.length < 0.3 ? "en" : "ru" };
  out.lead = /lead|лид|руковод|head of|техлид|cto|начальник|архитектор/i.test(v.title || text.slice(0, 200));
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const asks = [];
  let codeword = "";
  for (const s of sentences) {
    const code = /кодов\p{L}*\s+слов|(в начале|в конце|в первой строке|в теме|первым словом|первой строкой)\s+(вашего\s+)?(письма|отклика|сообщения|сопроводительного)/iu.test(s);
    const ask =
      /(укаж|напиш|пришл|присыл|приложи|прикреп|отправ|сообщ|ответь|расскаж|опиш|добав|поделит)\p{L}*/iu.test(s) &&
      /(отклик|письм|сопровод|сообщени|резюме|портфолио|github|гитхаб|ссылк|зарплат|ожидани|почт|telegram|телеграм|тестов|задани|вопрос|кейс)/iu.test(s);
    if (code && !codeword) {
      const q = s.match(QUOTED);
      codeword = q ? q[1].trim() : "?";
    }
    if ((code || ask) && asks.length < 4) asks.push(s.length > 220 ? s.slice(0, 217) + "..." : s);
  }
  if (codeword) out.codeword_hint = codeword;
  if (asks.length) out.asks = asks;
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]*\w/);
  if (email) out.apply_email = email[0];
  const own = String(v.channel_name || "").toLowerCase();
  const tg = [...text.matchAll(/(?<![\w/.])@([A-Za-z][\w]{4,31})/g)].map((m) => "@" + m[1]).find((x) => x.slice(1).toLowerCase() !== own);
  if (tg) out.apply_tg = tg;
  out.byEmail = !!email && /(присыла|отправля|направля|пиши|высыла|жд[её]м)\p{L}*[^.\n]{0,60}(почт|e-?mail|mail|адрес|ящик|@)/iu.test(text);
  return out;
}

export function companyCard(company) {
  if (!company) return {};
  const p = join(COMPANIES, slugify(company, 40) + ".md");
  return { card: fwd(p), fresh: existsSync(p) && ageDays(p) < 90 };
}
