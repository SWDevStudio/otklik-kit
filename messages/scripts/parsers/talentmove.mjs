export const name = "talentmove";
export const channel = "board";
export const hosts = ["talent-move.ru"];

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (!/(^|\.)talent-move\.ru$/.test(h)) return null;
  const m = u.pathname.match(/\/jobs\/([a-z0-9-]+)\/?$/i);
  if (!m) return { error: "нужна ссылка на вакансию вида talent-move.ru/jobs/<slug>" };
  const slug = m[1];
  const idm = slug.match(/-(\d+)$/);
  if (!idm) return { error: "в ссылке на вакансию нет числового id" };
  return { id: idm[1], url: `https://talent-move.ru/jobs/${slug}/`, slug: "talentmove-" + idm[1] };
}

function feat(headerHtml, cls, kit) {
  const m = headerHtml.match(new RegExp(`href=["']https://talent-move\\.ru/${cls}/[^"']*["'][^>]*>([^<]*)</a>`, "i"));
  return m ? kit.htmlText(m[1]) : "";
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const jp = kit.ldJobPosting(html);

  const titleM = html.match(/<h1 class="page-title">([^<]*)<\/h1>/);
  const title = titleM ? kit.htmlText(titleM[1]) : kit.htmlText(jp?.title || "");
  if (!title) throw new kit.NetError("на странице нет заголовка вакансии");

  const hStart = html.indexOf('<header class="job-header">');
  if (hStart === -1) throw new kit.NetError("на странице нет блока job-header с параметрами вакансии");
  const hEnd = html.indexOf("</header>", hStart);
  const headerHtml = html.slice(hStart, hEnd);
  const bodyStart = hEnd + "</header>".length;

  const company = feat(headerHtml, "company", kit) || kit.htmlText(jp?.hiringOrganization?.name || "");
  const location = feat(headerHtml, "location", kit);
  const work_format = feat(headerHtml, "format", kit);
  const seniority = feat(headerHtml, "seniority", kit);
  const employment = feat(headerHtml, "employment", kit);
  const expM = headerHtml.match(/<li class="job-features__item">([^<]+)<\/li>/);
  const years = expM ? kit.htmlText(expM[1]) : "";
  const experience = [seniority, years].filter(Boolean).join(", ");

  const tagsM = headerHtml.match(/<ul class="job-tags">([\s\S]*?)<\/ul>/);
  const key_skills = tagsM ? [...tagsM[1].matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map((x) => kit.htmlText(x[1])).filter(Boolean) : [];

  const salaryM = headerHtml.match(/<div class="job-salary__value">([^<]*)<\/div>/);
  const salary = salaryM ? kit.htmlText(salaryM[1]) : "";

  const endIdx = [
    html.indexOf('<div class="job-quality">', bodyStart),
    html.indexOf('<footer class="job-footer">', bodyStart),
    html.indexOf('<div class="job-after-content', bodyStart),
  ].filter((i) => i !== -1);
  const bodyEnd = endIdx.length ? Math.min(...endIdx) : html.length;
  const text = kit.htmlText(html.slice(bodyStart, bodyEnd));
  if (!text) throw new kit.NetError("на странице нет текста вакансии");

  const date_posted = String(jp?.datePosted || "").slice(0, 10);

  const v = { title, company, text, method: "talentmove html/" + via };
  if (location) v.location = location;
  if (experience) v.experience = experience;
  if (employment) v.employment = employment;
  if (work_format) v.work_format = work_format;
  if (key_skills.length) v.key_skills = key_skills;
  if (salary) v.salary = salary;
  if (date_posted) v.date_posted = date_posted;
  return v;
}

function parseCard(block, kit) {
  const linkM = block.match(/<a class="card-job__link" title="([^"]*)" href="([^"]*)">/);
  if (!linkM) return null;
  const title = kit.htmlText(linkM[1]);
  const url = linkM[2];
  const idm = url.match(/-(\d+)\/?$/);
  const id = idm ? idm[1] : "";

  const companyM = block.match(/<div class="card-job__company"><span>@<\/span>([^<]*)<\/div>/);
  const company = companyM ? kit.htmlText(companyM[1]) : "";

  const salM = block.match(/card-job__salary[^"]*"\s+data-salary-type="(estimated|verified)">\s*([^<]+?)\s*<\/div>/);
  let salary = "";
  let topRub = null;
  if (salM) {
    const raw = kit.htmlText(salM[2]);
    const km = raw.match(/([\d.,]+)\s*K/i);
    if (km) topRub = Math.round(parseFloat(km[1].replace(",", ".")) * 1000);
    else {
      const nm = raw.replace(/[^\d]/g, "");
      if (nm) topRub = +nm;
    }
    salary = raw + " тыс. RUB" + (salM[1] === "estimated" ? " (оценка)" : "");
  }

  const formatM = block.match(/card-job__feature--format">\s*<span>([^<]*)<\/span>/);
  const format = formatM ? kit.htmlText(formatM[1]) : "";
  const remote = format ? /удал/i.test(format) : null;

  return { id, url, title, company, salary, topRub, remote, exp: "", experience: "", responses: "", closed: false };
}

export async function search(query, opt, kit) {
  const cards = [];
  let total = 0;
  for (let p = 1; p <= (opt.maxPages || 20); p++) {
    const url = `https://talent-move.ru/?s=${encodeURIComponent(query)}${opt.remoteOnly ? "&format=fully-remote" : ""}&pg=${p}`;
    const { html } = await kit.page(url, { allowBrowser: false, maxAgeDays: 0.25 });
    if (p === 1) {
      const cm = html.match(/jobs-count-title">\s*\((\d+)\)/);
      total = cm ? +cm[1] : 0;
    }
    const blocks = html.split('<article class="card-job">').slice(1);
    if (!blocks.length) break;
    for (const b of blocks) {
      const c = parseCard(b.split("</article>")[0], kit);
      if (c && c.id) cards.push(c);
    }
    if (cards.length >= total) break;
  }
  return { cards, total };
}
