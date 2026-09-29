// Действия с формами hh.ru поверх cdp.mjs. Каждое действие проверяет результат; сохранение только явным вызовом.
import { sleep } from "./cdp.mjs";

export const MONTHS = ["", "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
export const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const low = (s) => norm(s).toLowerCase().replace(/ё/g, "е");

// Помощники внутри страницы: ставятся после каждого перехода, потому что переход сбрасывает window.
function installHelpers() {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const vis = (e) => e.getClientRects().length > 0;
  window.__hh = {
    norm,
    vis,
    leaves(text, root = document.body, below = -1e9) {
      return [...root.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && vis(e) && e.tagName !== "INPUT" && norm(e.textContent) === text && e.getBoundingClientRect().top > below);
    },
    smallest(text, root = document.body) {
      return [...root.querySelectorAll("*")].filter((e) => vis(e) && norm(e.innerText) === text).sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    },
    point(el, dx = 40) {
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const p = { x: r.x + Math.min(r.width / 2, dx), y: r.y + r.height / 2 };
      const hit = document.elementFromPoint(p.x, p.y);
      return { ...p, hit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)) };
    },
    box(label) {
      let b = [...document.querySelectorAll("body *")].find((e) => e.childElementCount === 0 && norm(e.textContent) === label);
      while (b && b.getBoundingClientRect().height < 45) b = b.parentElement;
      return b || null;
    },
    setValue(el, v) {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    checkboxes(root = document) {
      return [...root.querySelectorAll('input[type="checkbox"]')].map((c) => {
        let s = c, t = "";
        for (let k = 0; k < 6 && s && !t; k++) {
          s = s.parentElement;
          t = norm(s?.innerText);
        }
        return { c, t, row: s };
      });
    },
  };
}

export async function open(page, url, selector) {
  await page.goto(url, selector);
  await page.eval(installHelpers);
}

async function clickPoint(page, p) {
  if (!p) return false;
  await page.click(p.x, p.y);
  return true;
}
export const clickSel = async (page, sel) => clickPoint(page, await page.eval((s) => __hh.point(document.querySelector(s)), sel));
export const domClick = (page, sel) => page.eval((s) => { const el = document.querySelector(s); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true; }, sel);
export const clickText = async (page, text, scope = "body", below = -1e9) =>
  clickPoint(page, await page.eval((t, sc, b) => { const roots = [...document.querySelectorAll(sc)].filter(__hh.vis); const root = roots[roots.length - 1] || document.body; return __hh.point(__hh.leaves(t, root, b).pop()); }, text, scope, below));
export const setValue = (page, sel, v) => page.eval((s, v) => { const el = document.querySelector(s); if (!el) return false; __hh.setValue(el, v); return true; }, sel, v);
export const blur = (page) => page.eval(() => document.activeElement?.blur());

async function typeInto(page, sel, text) {
  await setValue(page, sel, "");
  await clickSel(page, sel);
  await sleep(200);
  await page.type(text);
}

// Выпадающий список magritte (месяцы): открыть n-й, прокрутить окно до пункта, кликнуть, проверить значение.
async function pickSelect(page, n, optionText) {
  const current = () => page.eval((n) => __hh.norm(document.querySelectorAll('[data-qa="magritte-select-activator"]')[n]?.innerText).replace("Месяц", "").trim(), n);
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickPoint(page, await page.eval((n) => __hh.point(document.querySelectorAll('[data-qa="magritte-select-activator"]')[n], 1e4), n));
    await sleep(900);
    const find = (t, scroll) => {
      const el = __hh.leaves(t).find((e) => e.closest('[role="option"]') && !e.closest('[data-qa="magritte-select-activator"]'));
      if (!el) return null;
      const opt = el.closest('[role="option"]');
      if (scroll) {
        let sc = opt.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (sc) {
          const o = opt.getBoundingClientRect(), s = sc.getBoundingClientRect();
          sc.style.scrollBehavior = "auto";
          sc.scrollTop += o.top - s.top - s.height / 2 + o.height / 2;
        }
      }
      const r = opt.getBoundingClientRect();
      const p = { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 };
      const hit = document.elementFromPoint(p.x, p.y);
      return { ...p, hit: !!hit && opt.contains(hit) };
    };
    if (!(await page.eval(find, optionText, true))) throw new Error(`в списке нет «${optionText}»`);
    await sleep(400);
    const p = await page.eval(find, optionText, false);
    if (p.hit) {
      await page.click(p.x, p.y);
      await sleep(700);
      if ((await current()) === optionText) return;
    }
    await page.key("Escape");
    await sleep(400);
  }
  throw new Error(`не удалось выбрать «${optionText}», выбрано «${await current()}»`);
}

const monthIdx = (page) =>
  page.eval(() => {
    const top = __hh.leaves("Начало работы")[0].getBoundingClientRect().top;
    const idx = [...document.querySelectorAll('[data-qa="magritte-select-activator"]')].map((e, i) => [i, e.getBoundingClientRect().top]).filter(([, t]) => t > top).map(([i]) => i);
    return { start: idx[0], end: idx[1] };
  });

async function expandResumeList(page) {
  for (let k = 0; k < 3; k++) {
    // текст кнопки в DOM идёт как «ещё 1Развернуть»
    const p = await page.eval(() => __hh.point([...document.querySelectorAll("button")].find((b) => __hh.vis(b) && /Развернуть/.test(b.textContent) && b.textContent.length < 40)));
    if (!p) return;
    await page.click(p.x, p.y);
    await sleep(700);
  }
}

// Чтение формы места работы (редактор записи профиля).
export async function readExperienceForm(page) {
  await expandResumeList(page);
  return page.eval(() => {
    const q = (s) => document.querySelector(s);
    const months = [...document.querySelectorAll('[data-qa="magritte-select-activator"]')].map((e) => __hh.norm(e.innerText).replace("Месяц", "").trim());
    const boxes = __hh.checkboxes().map(({ c, t }) => ({ t, checked: c.checked }));
    return {
      id: (location.pathname.match(/experience\/(\d+)/) || [])[1] || "",
      company: q('input[name="company"]')?.value || "",
      position: q('input[name="position"]')?.value || "",
      startYear: q('[data-qa="resume-editor-experience-start-year-input"]')?.value || "",
      endYear: q('[data-qa="resume-editor-experience-end-year-input"]')?.value || "",
      months: months.slice(-2),
      now: boxes.find((b) => b.t === "Работаю сейчас")?.checked ?? null,
      text: q('[data-qa="resume-editor-experience-description-input"]')?.value || "",
      site: q('[data-qa="resume-editor-experience-company-url-input"]')?.value || "",
      region: __hh.norm(q('[data-qa="resume-editor-experience-area-input"]')?.innerText).replace("Город или регион", "").trim(),
      industry: __hh.norm(q('[data-qa="trigger-root"]')?.innerText).replace("Сфера деятельности компании", "").trim(),
      employer: !q('[data-qa="resume-editor-experience-company-url-input"]'),
      resumes: boxes.filter((b) => b.t !== "Работаю сейчас"),
    };
  });
}

// Привязка к резюме: для управляемых резюме галочка = want, чужие резюме не трогаем.
async function setAttachments(page, managed, want) {
  await expandResumeList(page);
  const starts = (label, title) => low(label).startsWith(low(title).slice(0, 30));
  const rows = await page.eval(() => __hh.checkboxes().map(({ c, t }, i) => ({ i, t, checked: c.checked })).filter((b) => b.t !== "Работаю сейчас"));
  for (const r of rows) {
    const title = managed.find((m) => starts(r.t, m));
    if (!title) continue;
    const need = want.includes(title);
    if (need !== r.checked) {
      await clickPoint(page, await page.eval((i) => __hh.point(document.querySelectorAll('input[type="checkbox"]')[i]), r.i));
      await sleep(400);
    }
  }
  const after = await page.eval(() => __hh.checkboxes().map(({ c, t }) => ({ t, checked: c.checked })).filter((b) => b.t !== "Работаю сейчас"));
  for (const title of managed) {
    const row = after.find((r) => starts(r.t, title));
    if (!row) throw new Error(`в блоке «Резюме с этим местом работы» нет резюме «${title}»`);
    if (row.checked !== want.includes(title)) throw new Error(`не выставилась галочка резюме «${title}»`);
  }
}

// Заполнить запись места работы. id пустой: новая запись. Возвращает прочитанную форму.
export async function fillExperience(page, { id, resumeFrom, job, text, managed, want, save }) {
  const url = id ? `https://hh.ru/profile/edit/experience/${id}?resumeFrom=${resumeFrom}` : `https://hh.ru/profile/edit/experience?resumeFrom=${resumeFrom}`;
  await open(page, url, '[data-qa="resume-editor-experience-description-input"]');
  if (!id) {
    await clickSel(page, 'input[name="company"]');
    await page.type(job.company);
    await sleep(2500);
    if (job.employer) {
      const below = await page.eval(() => document.querySelector('input[name="company"]').getBoundingClientRect().bottom);
      if (!(await clickText(page, job.employer === true ? job.company : job.employer, "body", below))) throw new Error(`hh не предложил работодателя «${job.company}»: уберите employer или проверьте название`);
      await sleep(1200);
    } else {
      await page.key("Escape");
    }
    await typeInto(page, 'input[name="position"]', job.position);
    await sleep(1200);
    await page.key("Escape");
    await blur(page);
    await clickText(page, "Место работы", "body", 100);
    await sleep(600);
    if (!job.employer) {
      await clickSel(page, '[data-qa="resume-editor-experience-area-input"]');
      await sleep(700);
      await page.type(job.region);
      await sleep(1800);
      const areaBottom = await page.eval(() => document.querySelector('[data-qa="resume-editor-experience-area-input"]').getBoundingClientRect().bottom);
      if (!(await clickText(page, job.region, "body", areaBottom))) throw new Error("hh не нашёл город " + job.region);
      await sleep(800);
      if (job.site) {
        await typeInto(page, '[data-qa="resume-editor-experience-company-url-input"]', job.site);
        await blur(page);
      }
      await clickSel(page, '[data-qa="trigger-root"]');
      await sleep(1500);
      await clickSel(page, '[data-qa="tree-selector-search-input"]');
      await page.type(job.industry);
      await sleep(1500);
      if (!(await clickText(page, job.industry, '[role="dialog"]', 200))) throw new Error("в дереве сфер нет «" + job.industry + "»");
      await sleep(700);
      const picked = await page.eval(() => (__hh.norm([...document.querySelectorAll('[role="dialog"]')].find(__hh.vis)?.innerText).match(/Выбрано (\d+) из/) || [])[1]);
      if (picked !== "1") throw new Error("в сфере деятельности выбрано " + picked);
      await clickText(page, "Сохранить", '[data-qa="modal-footer"]');
      await sleep(1000);
    }
    const mi = await monthIdx(page);
    await pickSelect(page, mi.start, MONTHS[job.start[0]]);
    await typeInto(page, '[data-qa="resume-editor-experience-start-year-input"]', String(job.start[1]));
    if (job.end) {
      const now = await page.eval(() => __hh.checkboxes().find((b) => b.t === "Работаю сейчас")?.c.checked);
      if (now) {
        await clickText(page, "Работаю сейчас");
        await sleep(600);
      }
      await pickSelect(page, (await monthIdx(page)).end, MONTHS[job.end[0]]);
      await typeInto(page, '[data-qa="resume-editor-experience-end-year-input"]', String(job.end[1]));
    }
  }
  await setValue(page, '[data-qa="resume-editor-experience-description-input"]', text);
  await sleep(400);
  await setAttachments(page, managed, want);
  const form = await readExperienceForm(page);
  const problems = [];
  if (form.text !== text) problems.push("текст в форме не совпал с исходным");
  if (!id) {
    if (form.months[0] !== MONTHS[job.start[0]] || form.startYear !== String(job.start[1])) problems.push("не та дата начала");
    if (job.end && (form.months[1] !== MONTHS[job.end[0]] || form.endYear !== String(job.end[1]))) problems.push("не та дата окончания");
    if (norm(form.position) !== norm(job.position)) problems.push("не та должность");
  }
  if (problems.length) throw new Error(`${job.company}: ${problems.join("; ")}, не сохраняю`);
  if (save) {
    await clickSel(page, '[data-qa="profile-layout-save-button"]');
    await sleep(4000);
    if ((await page.url()).includes("/profile/edit/experience")) throw new Error(`${job.company}: hh не принял форму, она осталась открытой`);
  }
  return form;
}

// Ключевые навыки: привести к списку target (порядок = приоритет). Лимит hh: 30.
export async function setSkills(page, hash, target, save) {
  await open(page, `https://hh.ru/resume/edit/${hash}/keySkills`, '[data-qa="chips-trigger-input"]');
  const have = () => page.eval(() => [...document.querySelectorAll('[data-qa^="chips-trigger-chip-"]')].map((e) => e.getAttribute("data-qa").slice("chips-trigger-chip-".length)));
  const del = async (name) => clickPoint(page, await page.eval((n) => __hh.point(document.querySelector(`[data-qa="chips-trigger-chip-${CSS.escape(n)}"] [data-qa="chip-delete-action"]`), 10), name));
  for (const c of await have()) {
    if (target.some((t) => low(t) === low(c))) continue;
    await del(c);
    await sleep(500);
  }
  for (const sk of target) {
    if ((await have()).some((c) => low(c) === low(sk))) continue;
    const before = await have();
    await setValue(page, '[data-qa="chips-trigger-input"]', "");
    await clickSel(page, '[data-qa="chips-trigger-input"]');
    await sleep(300);
    await page.type(sk);
    let p = null;
    for (let i = 0; i < 10 && !p; i++) {
      await sleep(400);
      p = await page.eval((t) => {
        const lw = (s) => __hh.norm(s).toLowerCase().replace(/ё/g, "е");
        const head = __hh.leaves("Популярные")[0];
        if (!head) return null;
        let box = head.parentElement;
        while (box && !box.querySelector('[data-qa="chip"], button') && box.parentElement) box = box.parentElement;
        const el = [...box.querySelectorAll("*")].find((e) => e.childElementCount === 0 && __hh.vis(e) && lw(e.textContent) === lw(t));
        return el ? __hh.point(el, 1e4) : null;
      }, sk);
    }
    if (p) await page.click(p.x, p.y);
    else await page.key("Enter");
    await sleep(900);
    const fresh = (await have()).filter((a) => !before.includes(a));
    for (const f of fresh) if (low(f) !== low(sk)) {
      await del(f);
      await sleep(500);
    }
    await setValue(page, '[data-qa="chips-trigger-input"]', "");
    await page.key("Escape");
    await sleep(300);
  }
  const final = await have();
  const missing = target.filter((t) => !final.some((c) => low(c) === low(t)));
  const extra = final.filter((c) => !target.some((t) => low(t) === low(c)));
  if (save) {
    if (missing.length || extra.length) throw new Error(`навыки не совпали с целевыми (не хватает: ${missing.join(", ") || "-"}; лишние: ${extra.join(", ") || "-"}), не сохраняю`);
    await clickSel(page, '[data-qa="resume-partial-edit-save"]');
    await sleep(3000);
  }
  return { final, missing, extra };
}

// Уровни навыков: levels = { default: "Продвинутый", "Английский язык": "Базовый" }.
export async function setLevels(page, hash, levels, save) {
  await open(page, `https://hh.ru/resume/edit/${hash}/skillsLevels`, 'input[type="radio"]');
  const want = (sk) => levels[sk] || levels.default;
  const skills = await page.eval(() => [...document.querySelectorAll('input[type="radio"]')].map((i) => i.name).filter((n) => n.endsWith("Базовый")).map((n) => n.slice(0, -"Базовый".length)));
  for (const sk of skills) {
    const name = sk + want(sk);
    const done = await page.eval((n) => [...document.querySelectorAll('input[type="radio"]')].find((i) => i.name === n)?.checked, name);
    if (done) continue;
    await clickPoint(page, await page.eval((n) => { const i = [...document.querySelectorAll('input[type="radio"]')].find((x) => x.name === n); return __hh.point(i && (i.closest("label") || i.parentElement)); }, name));
    await sleep(350);
  }
  const state = await page.eval(() => Object.fromEntries([...document.querySelectorAll('input[type="radio"]')].filter((i) => i.checked).map((i) => { const lv = ["Базовый", "Средний", "Продвинутый"].find((l) => i.name.endsWith(l)); return [i.name.slice(0, -lv.length), lv]; })));
  const wrong = skills.filter((s) => state[s] !== want(s));
  if (save) {
    if (wrong.length) throw new Error("уровни выставились не у всех навыков: " + wrong.join(", "));
    await clickSel(page, '[data-qa="resume-partial-edit-save"]');
    await sleep(3000);
  }
  return { skills: skills.length, wrong };
}

export async function setAbout(page, hash, text, save) {
  await open(page, `https://hh.ru/resume/edit/${hash}/about`, '[data-qa="resume-editor-about"]');
  await setValue(page, '[data-qa="resume-editor-about"]', text);
  await sleep(400);
  const got = await page.eval(() => document.querySelector('[data-qa="resume-editor-about"]').value);
  if (got !== text) throw new Error("текст «О себе» в форме не совпал с исходным");
  if (save) {
    await clickPoint(page, await page.eval(() => __hh.point([...document.querySelectorAll("button")].find((b) => __hh.vis(b) && __hh.norm(b.textContent) === "Сохранить"))));
    await sleep(3500);
  }
}

// Блок «Желаемая профессия и условия»: название, зарплата, тип занятости, формат, командировки.
export async function setPosition(page, hash, r, save) {
  await open(page, `https://hh.ru/resume/edit/${hash}/position`, '[data-qa="resume-salary-amount"]');
  if (r.title) {
    await typeInto(page, '[data-qa="resume-edit-title-suggest"]', r.title);
    await sleep(1200);
    await page.key("Escape");
    await blur(page);
  }
  if (r.salary !== undefined) {
    // поле с маской иногда дописывает цифры к прежнему значению (300 000 → 3 000 000): читаем обратно и набираем заново
    const digits = () => page.eval(() => (document.querySelector('[data-qa="resume-salary-amount"]')?.value || "").replace(/\D/g, ""));
    for (let attempt = 0; attempt < 4; attempt++) {
      await typeInto(page, '[data-qa="resume-salary-amount"]', String(r.salary));
      await sleep(300);
      if ((await digits()) === String(r.salary)) break;
      await page.eval(() => document.querySelector('[data-qa="resume-salary-amount"]')?.select());
      await page.key("Backspace");
      await sleep(300);
    }
    await blur(page);
    if (r.currency) await clickSel(page, `[data-qa="resume-currency-input-${r.currency}"]`);
  }
  const multi = async (label, want) => {
    await page.eval((l) => __hh.box(l)?.scrollIntoView({ block: "center" }), label);
    await sleep(700);
    await clickPoint(page, await page.eval((l) => { const b = __hh.box(l); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 3, y: r.y + r.height * 0.7 }; }, label));
    await sleep(1000);
    const rows = () => page.eval(() => __hh.checkboxes(document).filter(({ c }) => c.closest('[role="listbox"], [role="dialog"]')).map(({ c, t }, i) => ({ t, checked: c.checked })));
    let list = await rows();
    if (!list.length) throw new Error(label + ": список не открылся");
    const absent = want.filter((w) => !list.some((row) => row.t === w));
    if (absent.length) throw new Error(label + ": в списке hh нет «" + absent.join("», «") + "»; есть: " + list.map((row) => row.t).join(", "));
    for (const row of list) if (want.includes(row.t) !== row.checked) {
      await clickPoint(page, await page.eval((t) => { const hit = __hh.checkboxes(document).find(({ c, t: tt }) => c.closest('[role="listbox"], [role="dialog"]') && tt === t); return hit && __hh.point(hit.row, 24); }, row.t));
      await sleep(400);
    }
    list = await rows();
    const bad = list.filter((row) => want.includes(row.t) !== row.checked);
    if (bad.length) throw new Error(label + ": не выставились " + bad.map((b) => b.t).join(", "));
    // кнопка внутри окна: без прокрутки страницы, клик в центр
    const applyAt = await page.eval(() => { const b = document.querySelector('[data-qa="magritte-select-apply"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (!(await clickPoint(page, applyAt))) throw new Error(label + ": нет кнопки «Выбрать»");
    await sleep(800);
    if (await page.eval(() => [...document.querySelectorAll('[role="listbox"], [role="dialog"]')].some((e) => e.getClientRects().length))) throw new Error(label + ": окно выбора не закрылось");
  };
  if (r.employment) await multi("Тип занятости", r.employment);
  if (r.format) await multi("Формат работы", r.format);
  if (r.trips) {
    const now = await page.eval(() => __hh.norm(__hh.box("Командировки")?.innerText).replace("Командировки", "").trim());
    if (now !== r.trips) {
      await clickPoint(page, await page.eval(() => __hh.point(__hh.box("Командировки"), 200)));
      await sleep(900);
      if (!(await clickText(page, r.trips, '[role="listbox"], [role="dialog"]'))) throw new Error("нет варианта командировок " + r.trips);
      await sleep(700);
      await clickSel(page, '[data-qa="magritte-select-apply"]');
      await sleep(500);
    }
  }
  const check = await page.eval(() => ({
    title: document.querySelector('[data-qa="resume-edit-title-suggest"]')?.value,
    salary: (document.querySelector('[data-qa="resume-salary-amount"]')?.value || "").replace(/\D/g, ""),
    fields: Object.fromEntries(["Тип занятости", "Формат работы", "Командировки"].map((l) => [l, __hh.norm(__hh.box(l)?.innerText).replace(l, "").trim()])),
  }));
  const problems = [];
  if (r.title && check.title !== r.title) problems.push("название");
  if (r.salary !== undefined && check.salary !== String(r.salary)) problems.push("зарплата");
  for (const x of r.employment || []) if (!check.fields["Тип занятости"].includes(x)) problems.push("тип занятости " + x);
  for (const x of r.format || []) if (!check.fields["Формат работы"].includes(x)) problems.push("формат " + x);
  if (r.trips && check.fields["Командировки"] !== r.trips) problems.push("командировки");
  if (problems.length) throw new Error("условия не выставились: " + problems.join(", ") + ", не сохраняю; в форме: " + JSON.stringify({ title: check.title, salary: check.salary, ...check.fields }));
  if (save) {
    await clickPoint(page, await page.eval(() => __hh.point([...document.querySelectorAll("button")].find((b) => __hh.vis(b) && __hh.norm(b.textContent) === "Сохранить"))));
    await sleep(3500);
  }
  return check;
}

// Резюме аккаунта: hash и название.
export async function listResumes(page) {
  await open(page, "https://hh.ru/applicant/resumes", "body");
  await sleep(1500);
  return page.eval(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="/resume/"]')) {
      const hash = (a.getAttribute("href").match(/\/resume\/([0-9a-f]{20,})/) || [])[1];
      const title = __hh.norm(a.querySelector('[data-qa="resume-title"]')?.innerText);
      if (hash && title && !seen.has(hash)) seen.set(hash, title);
    }
    return [...seen].map(([hash, title]) => ({ hash, title }));
  });
}

// Все записи опыта в профиле: открыть редактор каждой и прочитать поля и привязку.
export async function listExperience(page, log = () => {}) {
  const PROFILE = "https://hh.ru/applicant/profile/me";
  const toProfile = async () => {
    await open(page, PROFILE, '[data-qa^="edit-experience-button-"]');
    for (let k = 0; k < 4; k++) {
      const c = await page.eval(() => { let c = 0; for (const el of document.querySelectorAll("button, a, span")) if (__hh.vis(el) && el.childElementCount === 0 && /^(Развернуть|Показать все|Показать ещё)/.test(__hh.norm(el.textContent))) { el.click(); c++; } return c; });
      if (!c) break;
      await sleep(700);
    }
    return page.eval(() => [...document.querySelectorAll("[data-qa]")].map((e) => e.getAttribute("data-qa")).filter((q) => /^edit-experience-button-\d+$/.test(q)));
  };
  const buttons = await toProfile();
  const out = [];
  for (let i = 0; i < buttons.length; i++) {
    if (i) await toProfile();
    await domClick(page, `[data-qa="${buttons[i]}"]`);
    await page.waitFor('[data-qa="resume-editor-experience-description-input"]');
    await sleep(800);
    await page.eval(installHelpers);
    const f = await readExperienceForm(page);
    out.push(f);
    log(`${i + 1}/${buttons.length} ${f.company} · ${f.position} · ${f.startYear}-${f.endYear || "сейчас"} · резюме: ${f.resumes.filter((r) => r.checked).map((r) => r.t).join(" | ") || "-"}`);
  }
  return out;
}

// Текущее состояние резюме для init и verify.
export async function readResume(page, hash) {
  await open(page, `https://hh.ru/resume/edit/${hash}/position`, '[data-qa="resume-salary-amount"]');
  const pos = await page.eval(() => {
    const f = (l) => __hh.norm(__hh.box(l)?.innerText).replace(l, "").trim();
    const cur = ["RUR", "EUR", "USD"].find((c) => document.querySelector(`[data-qa="resume-currency-input-${c}"]`)?.checked);
    return { title: document.querySelector('[data-qa="resume-edit-title-suggest"]')?.value || "", salary: +(document.querySelector('[data-qa="resume-salary-amount"]')?.value || "").replace(/\D/g, "") || undefined, currency: cur, employment: f("Тип занятости"), format: f("Формат работы"), trips: f("Командировки") };
  });
  const split = (s) => (s ? s.split(", ").map((x) => x.trim()).filter(Boolean) : undefined);
  await open(page, `https://hh.ru/resume/edit/${hash}/keySkills`, '[data-qa="chips-trigger-input"]');
  const skills = await page.eval(() => [...document.querySelectorAll('[data-qa^="chips-trigger-chip-"]')].map((e) => e.getAttribute("data-qa").slice("chips-trigger-chip-".length)));
  let about = "";
  try {
    await open(page, `https://hh.ru/resume/edit/${hash}/about`, '[data-qa="resume-editor-about"]');
    about = await page.eval(() => document.querySelector('[data-qa="resume-editor-about"]').value);
  } catch {}
  return { hash, title: pos.title, salary: pos.salary, currency: pos.currency, employment: split(pos.employment), format: split(pos.format), trips: pos.trips || undefined, about, skills };
}

// Текст опубликованного резюме: для сверки, что каждый текст виден работодателю.
export async function resumeText(page, hash) {
  await open(page, `https://hh.ru/resume/${hash}`, '[data-qa^="edit-experience-button-"]');
  for (let k = 0; k < 4; k++) {
    const c = await page.eval(() => { let c = 0; for (const el of document.querySelectorAll("button, a, span")) if (__hh.vis(el) && el.childElementCount === 0 && /^(Развернуть|Показать все|Показать ещё|Ещё)/.test(__hh.norm(el.textContent))) { el.click(); c++; } return c; });
    if (!c) break;
    await sleep(800);
  }
  return page.eval(() => ({
    title: __hh.norm(document.querySelector('[data-qa="resume-block-title-position"]')?.innerText),
    jobs: [...document.querySelectorAll("[data-qa]")].filter((e) => /^edit-experience-button-\d+$/.test(e.getAttribute("data-qa"))).length,
    body: __hh.norm(document.body.innerText),
  }));
}
