export const name = "hirify";
export const channel = "board";
export const hosts = ["hirify.me"];

const WF = { remote: "удалённо", hybrid: "гибрид", onsite: "офис" };
const WT = { fulltime: "полная", parttime: "частичная", project: "проектная", internship: "стажировка" };
const ET = { employment: "по найму", b2b_contract: "B2B/ИП", contract: "контракт", internship: "стажировка", freelance: "фриланс", temporary: "временная" };
const GRADE = { trainee: "стажёр", junior: "junior", middle: "middle", senior: "senior", lead: "lead", head: "head", director: "director" };
const GRADE_RANK = { trainee: 0, junior: 1, middle: 2, senior: 3, lead: 4, head: 5, director: 6 };
const RATES = { RUR: 1, RUB: 1, USD: 90, EUR: 100, GBP: 115, KZT: 0.18, UZS: 0.0072, BYN: 28, KGS: 1 };

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (h !== "hirify.me") return null;
  const m = u.pathname.match(/^\/jobs\/(\d+)([a-z0-9-]*)/i);
  if (!m) return /^\/jobs\/?$/.test(u.pathname) ? { error: "ссылка на список вакансий hirify, а не на вакансию" } : null;
  return { id: m[1], url: `https://hirify.me/jobs/${m[1]}${m[2]}`, slug: "hirify-" + m[1] };
}

function company(t) {
  return t && t !== "%hirify_global%" ? t : "";
}

function salaryStr(s) {
  if (!s || (!s.min && !s.max)) return "";
  const period = s.salary_period === "year" ? " в год" : s.salary_period === "month" ? " в месяц" : "";
  return [s.min && `от ${s.min}`, s.max && `до ${s.max}`].filter(Boolean).join(" ") + (s.currency ? " " + s.currency : "") + period;
}

function topRub(s) {
  if (!s) return null;
  const top = s.max;
  if (!top) return null;
  const rate = RATES[String(s.currency || "RUB").toUpperCase()];
  return rate ? Math.round(top * rate) : null;
}

function expCode(grades) {
  const rank = Math.max(-1, ...(grades || []).map((g) => (g.name in GRADE_RANK ? GRADE_RANK[g.name] : -1)));
  if (rank < 0) return "";
  if (rank === 0) return "none";
  if (rank === 1) return "1-3";
  if (rank <= 3) return "3-6";
  return "6+";
}

export async function extract(src, kit) {
  const { data, via } = await kit.json(`https://api.hirify.me/api/vacancies/${src.id}`);
  const v = {
    title: kit.htmlText(data.title || ""),
    company: company(data.company_title),
    text: kit.htmlText(data.text || "").replace(/%[a-z_]+%/gi, "").replace(/\n{3,}/g, "\n\n").trim(),
    method: "hirify api/" + via,
  };
  const sal = salaryStr(data.salary);
  if (sal) v.salary = sal;
  const regions = (data.regions || []).map((r) => r.name).filter(Boolean);
  if (regions.length) v.location = regions.join(", ");
  const grades = (data.grades || []).map((g) => GRADE[g.name] || g.name).filter(Boolean);
  if (grades.length) v.experience = grades.join(", ");
  const et = (data.employee_type || []).map((x) => ET[x] || x).filter(Boolean);
  const wt = data.work_type ? WT[data.work_type] || data.work_type : "";
  const employment = et.length ? [...new Set(wt && wt !== "полная" ? [...et, wt] : et)] : wt ? [wt] : [];
  if (employment.length) v.employment = employment.join(", ");
  const wf = (data.work_format || []).map((x) => WF[x] || x).filter(Boolean);
  if (wf.length) v.work_format = wf.join(", ");
  const skills = (data.tags || []).map((t) => t.name).filter(Boolean);
  if (skills.length) v.key_skills = skills;
  if (data.created_at) v.date_posted = String(data.created_at).slice(0, 10);
  if (data.is_archived) v.archived = true;
  return v;
}

export async function search(query, opt, kit) {
  const cards = [];
  let total = 0;
  for (let p = 1; p <= (opt.maxPages || 20); p++) {
    const url = `https://api.hirify.me/api/vacancies?page=${p}&search=${encodeURIComponent(query)}${opt.remoteOnly ? "&work_format=remote" : ""}`;
    const { data } = await kit.json(url, { maxAgeDays: 0.25 });
    const list = data?.data || [];
    if (p === 1) total = data?.total ?? 0;
    for (const it of list) {
      const grades = it.grades || [];
      cards.push({
        id: String(it.id),
        url: `https://hirify.me/jobs/${it.slug}`,
        title: it.title || "",
        company: company(it.company_title),
        salary: salaryStr(it.salary),
        topRub: topRub(it.salary),
        remote: (it.work_format || []).length ? (it.work_format || []).includes("remote") : null,
        exp: expCode(grades),
        experience: grades.map((g) => GRADE[g.name] || g.name).join(", "),
      });
    }
    if (!list.length || p * (data?.per_page || list.length || 15) >= total) break;
  }
  return { cards, total };
}
