// Отдельный Chrome с портом отладки и минимальный клиент DevTools Protocol без npm-пакетов.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, findBrowser } from "../lib.mjs";

export const PORT = +(process.env.HH_CDP_PORT || 9333);
export const PROFILE_DIR = process.env.HH_BROWSER_PROFILE || join(CACHE, "hh-browser");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtools(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

export async function browserUp() {
  try {
    await devtools("/json/version");
    return true;
  } catch {
    return false;
  }
}

// Окно видимое: в нём пользователь сам входит в аккаунт, дальше скрипты работают в этой же сессии.
export async function launch(url) {
  if (await browserUp()) return false;
  const bin = findBrowser();
  if (!bin) throw new Error("не найден Chrome или Edge: укажите путь в переменной CHROME_PATH");
  mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", "--lang=ru-RU", "--window-size=1400,1000", url];
  spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
  for (let i = 0; i < 60 && !(await browserUp()); i++) await sleep(250);
  if (!(await browserUp())) throw new Error(`браузер не открыл порт отладки ${PORT}`);
  return true;
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
      if (m.id && this.pending.has(m.id)) {
        const { ok, bad } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) bad(new Error(m.error.message));
        else ok(m.result);
      } else if (m.method === "Page.javascriptDialogOpening") {
        // «Покинуть страницу?» при уходе с несохранённой формы: сохранение делается только явной кнопкой
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, bad) => this.pending.set(id, { ok, bad }));
  }
  // fn выполняется в странице: только самодостаточные функции, аргументы через JSON
  async eval(fn, ...args) {
    const r = await this.send("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("ошибка в странице: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  url() {
    return this.eval(() => location.href);
  }
  async waitFor(selector, ms = 20000) {
    for (let t = 0; t < ms; t += 300) {
      if (await this.eval((s) => !!document.querySelector(s), selector).catch(() => false)) return true;
      await sleep(300);
    }
    throw new Error(`на странице нет ${selector}`);
  }
  async goto(url, selector) {
    await this.send("Page.navigate", { url });
    await sleep(1000);
    for (let t = 0; t < 30000; t += 300) {
      const ready = await this.eval(() => document.readyState !== "loading").catch(() => false);
      if (ready) break;
      await sleep(300);
    }
    if (selector) await this.waitFor(selector);
    await sleep(600);
  }
  async click(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  async type(text) {
    for (const ch of text) {
      await this.send("Input.insertText", { text: ch });
      await sleep(25);
    }
  }
  async key(key) {
    const codes = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 };
    const text = key === "Enter" ? "\r" : undefined;
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: codes[key], text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: codes[key] });
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }
  close() {
    this.ws.close();
  }
}

export async function connect(match = "hh.ru") {
  if (!(await browserUp())) throw new Error(`браузер не запущен: сначала выполните login (порт ${PORT})`);
  let list = await devtools("/json/list");
  let target = list.find((t) => t.type === "page" && t.url.includes(match)) || list.find((t) => t.type === "page");
  if (!target) {
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    list = await devtools("/json/list");
    target = list.find((t) => t.type === "page");
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => {
    ws.onopen = ok;
    ws.onerror = () => bad(new Error("не удалось подключиться к вкладке браузера"));
  });
  const page = new Page(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  // окно может быть в фоне: без эмуляции фокуса выпадающие подсказки hh не открываются
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return page;
}
