export const name = "hh";
export const channel = "hh";
export const hosts = ["hh.ru", "hh.kz"];

const EXP = { noExperience: "без опыта", between1And3: "1-3 года", between3And6: "3-6 лет", moreThan6: "более 6 лет" };
const EXP_CODE = { noExperience: "none", between1And3: "1-3", between3And6: "3-6", moreThan6: "6+" };
const WF = { ON_SITE: "офис", REMOTE: "удалённо", HYBRID: "гибрид", FIELD_WORK: "разъездной" };
export const RATES = { RUR: 1, RUB: 1, USD: 90, EUR: 100, KZT: 0.18, UZS: 0.0072, BYN: 28, KGS: 1 };

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  const m = /(^|\.)hh\.(ru|kz)$/.test(h) && u.pathname.match(/\/vacancy\/(\d+)/);
  return m ? { id: m[1], url: `https://hh.ru/vacancy/${m[1]}`, slug: "hh-" + m[1] } : null;
}

function state(html, kit) {
  const st = html.match(/<template[^>]*id="HH-Lux-InitialState"[^>]*>([\s\S]*?)<\/template>/);
  if (!st) return null;
  try {
    return JSON.parse(kit.ent(st[1]));
  } catch {
    return null;
  }
}

function salary(c = {}) {
  if (!c || c.noCompensation || !(c.from || c.to)) return "";
  return [c.from && `от ${c.from}`, c.to && `до ${c.to}`].filter(Boolean).join(" ") + (c.currencyCode ? " " + c.currencyCode : "") + (c.gross === true ? " до вычета" : c.gross === false ? " на руки" : "");
}

function topRub(c = {}) {
  if (!c || c.noCompensation || !c.to) return null;
  const rate = RATES[String(c.currencyCode || "RUR").toUpperCase()];
  return rate ? +c.to * rate : null;
}

const formatCodes = (list) => (list || []).flatMap((x) => (typeof x === "string" ? [x] : x?.workFormatsElement || []));

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const jp = kit.ldJobPosting(html);
  if (!jp) throw new Error("на странице нет описания вакансии (JobPosting)");
  const v = { ...kit.fromJobPosting(jp), method: "hh ld+json/" + via };
  const s = state(html, kit);
  const vv = s?.vacancyView?.vacancyFull?.vacancy || s?.vacancyView;
  if (vv) {
    v.salary = salary(vv.compensation) || v.salary;
    const skills = (Array.isArray(vv.keySkills) ? vv.keySkills : vv.keySkills?.keySkill || []).map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean);
    v.key_skills = [...new Map(skills.map((x) => [x.toLowerCase().replace(/[–—-]/g, "-"), x])).values()];
    v.experience = EXP[vv.workExperience] || vv.workExperience || "";
    v.employment = { FULL: "полная", PART: "частичная", PROJECT: "проектная", PROBATION: "стажировка" }[vv.employmentForm] || v.employment;
    v.work_format = formatCodes(vv.workFormats).map((x) => WF[x] || x).join(", ");
    v.location = vv.area?.name || v.location;
    v.archived = !!(vv.status?.archived || vv.closedForApplicants);
    const ci = vv.contactInfo || s.vacancyView?.contactInfo;
    if (ci) v.contacts = [ci.fio, ci.email, ...(ci.phones?.phones || []).map((p) => p.formatted || `+${p.country}${p.city}${p.number}`)].filter(Boolean).join("; ");
    const rs = s.applicantVacancyResponseStatuses?.[src.id];
    if (rs?.shortVacancy?.["@responseLetterRequired"]) v.letter_required = true;
    if (rs?.test?.required || rs?.shortVacancy?.userTestPresent) v.test_required = true;
  }
  return v;
}

export async function search(query, opt, kit) {
  const cards = [];
  let total = 0;
  for (let p = 0; p < (opt.maxPages || 20); p++) {
    const url = `https://hh.ru/search/vacancy?text=${encodeURIComponent(query)}${opt.remoteOnly ? "&work_format=REMOTE" : ""}&items_on_page=100&page=${p}`;
    let st;
    try {
      st = state((await kit.page(url, { allowBrowser: false, maxAgeDays: 0.25 })).html, kit);
    } catch (e) {
      if (!p) throw e;
      break;
    }
    const res = st?.vacancySearchResult;
    const list = res?.vacancies || [];
    if (!p) total = res?.totalResults || 0;
    for (const v of list)
      cards.push({
        id: String(v.vacancyId),
        url: `https://hh.ru/vacancy/${v.vacancyId}`,
        title: v.name || "",
        company: v.company?.visibleName || v.company?.name || "",
        salary: salary(v.compensation),
        topRub: topRub(v.compensation),
        remote: formatCodes(v.workFormats).includes("REMOTE"),
        exp: EXP_CODE[v.workExperience] || "",
        experience: EXP[v.workExperience] || "",
        letter: !!v["@responseLetterRequired"],
        test: !!v.userTestPresent,
        responses: v.totalResponsesCount ?? v.responsesCount ?? "",
        closed: !!v.closedForApplicants,
      });
    if (list.length < 100 || (p + 1) * 100 >= total) break;
  }
  return { cards, total };
}
