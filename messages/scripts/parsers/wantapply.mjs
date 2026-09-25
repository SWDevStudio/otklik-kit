export const name = "wantapply";
export const channel = "board";
export const hosts = ["wantapply.com"];

const EMP = { FULL_TIME: "full-time", PART_TIME: "part-time", CONTRACTOR: "contract", TEMPORARY: "temporary", INTERN: "internship", VOLUNTEER: "volunteer", PER_DIEM: "per-diem", OTHER: "" };
const RATES = { USD: 90, EUR: 100, GBP: 115 };
const ORIGINS = /https?:\/\/(?:[\w-]+\.)*(hh\.ru|career\.habr\.com|getmatch\.ru)\/[^\s"'<>]+/i;

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (h !== "wantapply.com") return null;
  const seg = u.pathname.replace(/^\/+|\/+$/g, "");
  if (!seg || seg.includes("/")) return null;
  if (!/-at-[a-z0-9-]+$/i.test(seg)) return { error: "нужна ссылка на вакансию вида wantapply.com/<должность>-at-<компания>" };
  return { id: seg, url: `https://wantapply.com/${seg}`, slug: "wantapply-" + seg };
}

function tagNames(html, type) {
  const flat = html.replace(/\\"/g, '"');
  const re = new RegExp(`"tagType":"${type}","name":"([^"]+)"`, "g");
  const seen = new Map();
  for (const m of flat.matchAll(re)) {
    const v = m[1].replace(/\\u([\da-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()];
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const origin = html.match(ORIGINS);
  if (origin) {
    try {
      const v = await kit.follow(origin[0], name);
      if (v) return v;
    } catch {}
  }
  const jp = kit.ldJobPosting(html);
  if (!jp) throw new Error("на странице нет описания вакансии (JobPosting)");
  const v = { ...kit.fromJobPosting(jp), method: "wantapply ld+json/" + via };
  const desc = html.match(/<div class="Description">([\s\S]*?)<\/div><p class="text-sm text-muted-foreground mt-8">/);
  if (desc) v.text = kit.htmlText(desc[1]);
  const emp = [].concat(jp.employmentType || []).map((e) => EMP[e] ?? String(e).toLowerCase().replace(/_/g, "-")).filter(Boolean);
  if (emp.length) v.employment = emp.join(", ");
  const wf = tagNames(html, "workplaceTypes");
  if (wf.length) v.work_format = wf.join(", ");
  const loc = tagNames(html, "jobLocations");
  if (loc.length) v.location = loc.join(", ");
  const lvl = tagNames(html, "levels");
  if (lvl.length) v.experience = lvl.join(", ");
  return v;
}

export async function search(query, opt, kit) {
  const cards = [];
  const seen = new Set();
  let total = 0;
  for (let p = 1; p <= (opt.maxPages || 5); p++) {
    const url = `https://wantapply.com/?search=${encodeURIComponent(query)}${opt.remoteOnly ? "&workplaceTypes=remote" : ""}${p > 1 ? "&page=" + p : ""}`;
    const { html } = await kit.page(url, { maxAgeDays: 0.25 });
    if (p === 1) total = +((html.match(/mt-4 mb-4">([\d,]+) jobs?</) || [])[1] || "0").replace(/,/g, "");
    let added = 0;
    for (const m of html.matchAll(/href="(\/[a-z0-9][a-z0-9-]*-at-[a-z0-9-]+)"/g)) {
      const path = m[1];
      if (seen.has(path)) continue;
      seen.add(path);
      const w = html.slice(m.index, m.index + 5000);
      const title = kit.htmlText((w.match(/text-lg font-semibold[^"]*">([^<]*)/) || [, ""])[1]);
      if (!title) continue;
      added++;
      const company = kit.htmlText((w.match(/size-12\.5 rounded-full object-contain" alt="([^"]*)"/) || [, ""])[1]);
      const rowRaw = (w.match(/items-center gap-1 text-sm">([\s\S]*?)<\/div>/) || [, ""])[1];
      const parts = kit.htmlText(rowRaw).split("·").map((s) => s.trim()).filter(Boolean);
      let salary = "";
      let topRub = null;
      let experience = "";
      for (const part of parts) {
        if (/^\$/.test(part)) {
          salary = part;
          const nums = (part.replace(/[$,]/g, "").match(/[\d.]+/g) || []).map(Number);
          const top = nums.length ? Math.max(...nums) : null;
          topRub = top ? Math.round(top * RATES.USD) : null;
        } else {
          experience = experience ? experience + ", " + part : part;
        }
      }
      const remote = />Remote</.test(w) ? true : />Hybrid</.test(w) || />On-site</.test(w) ? false : null;
      cards.push({ id: path.slice(1), url: "https://wantapply.com" + path, title, company, salary, topRub, remote, exp: "", experience, responses: "", closed: false });
    }
    if (!added) break;
  }
  return { cards, total: total || cards.length };
}
