export const name = "geekjob";
export const channel = "board";
export const hosts = ["geekjob.ru"];

const EMPLOYMENT = {
  FULL_TIME: "полная",
  PART_TIME: "частичная",
  CONTRACTOR: "проектная",
  TEMPORARY: "временная",
  INTERN: "стажировка",
  VOLUNTEER: "волонтёрство",
  PER_DIEM: "разовая",
};

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (!/(^|\.)geekjob\.ru$/.test(h)) return null;
  const m = u.pathname.match(/^\/vacancy\/([a-f0-9]{24})/i);
  if (!m) return { error: "ссылка geekjob.ru не похожа на вакансию (/vacancy/<id>)" };
  const id = m[1].toLowerCase();
  return { id, url: `https://geekjob.ru/vacancy/${id}`, slug: "geekjob-" + id };
}

function parseAmt(s) {
  const m = String(s || "").match(/([\d.,]+)\s*([KM]?)/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(",", "."));
  if (!n && n !== 0) return null;
  if (/K/i.test(m[2])) n *= 1000;
  if (/M/i.test(m[2])) n *= 1000000;
  return Math.round(n);
}

function topRub(s) {
  if (!s) return null;
  const parts = s.split(/[—-]/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parseAmt(parts[parts.length - 1]);
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const jp = kit.ldJobPosting(html);
  if (!jp) throw new Error("на странице нет описания вакансии (JobPosting)");
  const v = { ...kit.fromJobPosting(jp), method: "geekjob ld+json/" + via };

  const loc = html.match(/<div class="location">([^<]*)<\/div>/);
  if (loc) v.location = kit.htmlText(loc[1]).trim();

  const jf = html.match(/<span class="jobformat">([\s\S]*?)<\/span>/);
  if (jf) {
    const [fmt, exp] = jf[1].split(/<br\s*\/?>/i).map((s) => kit.htmlText(s).trim());
    if (fmt) v.work_format = fmt.split(" • ").join(", ");
    if (exp) v.experience = exp.replace(/^Опыт работы\s*/i, "");
  }

  const salHeader = html.match(/<div class="jobinfo">[\s\S]*?<span class="salary">([^<]*)<\/span>/);
  if (salHeader && salHeader[1].trim()) v.salary = kit.htmlText(salHeader[1]).trim();

  if (v.employment) v.employment = v.employment.split(", ").map((e) => EMPLOYMENT[e.trim()] || e.trim()).join(", ");

  const spec = html.match(/Специализация<\/b><br>([\s\S]*?)(?:<br><b>|<hr>)/);
  if (spec) {
    const skills = [...spec[1].matchAll(/<a class=chip[^>]*>([^<]*)<\/a>/g)].map((m) => kit.htmlText(m[1]).trim()).filter(Boolean);
    if (skills.length) v.key_skills = skills;
  }

  if (/вакансия (снята с публикации|в архиве|закрыта)/i.test(html)) v.archived = true;

  return v;
}

export async function search(query, opt, kit) {
  const cards = [];
  const seen = new Set();
  let total = 0;
  const maxPages = opt.maxPages || 20;
  for (let p = 1; p <= maxPages; p++) {
    const url = `https://geekjob.ru/vacancies?qs=${encodeURIComponent(query)}${p > 1 ? "&page=" + p : ""}`;
    let html;
    try {
      html = kit.renderDom(url);
    } catch (e) {
      if (p === 1) throw e;
      break;
    }
    const foundTotal = html.match(/Найдено\s+(\d+)\s+ваканси/);
    if (foundTotal) total = +foundTotal[1];
    const listBlock = html.match(/id="serplist">([\s\S]*?)<\/ul>/);
    if (!listBlock) break;
    const items = listBlock[1].split('<li class="collection-item');
    let added = 0;
    for (const raw of items) {
      const idm = raw.match(/vacancy\/([a-f0-9]{24})/i);
      if (!idm) continue;
      const id = idm[1].toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      added++;
      const titleM = raw.match(/class="title">([^<]*)<\/a>/);
      const companyM = raw.match(/company-name">\s*<a[^>]*>([^<]*)<\/a>/);
      const infoM = raw.match(/<div class="info">([\s\S]*?)<\/div>/);
      let location = "";
      let salary = "";
      if (infoM) {
        const parts = infoM[1].split(/<br\s*\/?>/i).map((s) => kit.htmlText(s).trim());
        if (parts.length > 1) {
          location = parts[0];
          salary = parts[1];
        } else salary = parts[0] || "";
      }
      const remote = /remote-label/.test(raw);
      const office = /inhouse-label/.test(raw);
      cards.push({
        id,
        url: `https://geekjob.ru/vacancy/${id}`,
        title: titleM ? kit.htmlText(titleM[1]).trim() : "",
        company: companyM ? kit.htmlText(companyM[1]).trim() : "",
        salary,
        topRub: topRub(salary),
        remote: remote ? true : office ? false : null,
        exp: "",
        experience: "",
        responses: "",
        closed: false,
        letter: false,
        test: /withtest-label/.test(raw),
      });
    }
    if (added === 0) break;
    if (total && cards.length >= total) break;
  }
  const out = opt.remoteOnly ? cards.filter((c) => c.remote === true) : cards;
  return { cards: out, total };
}
