export const name = "careerspace";
export const channel = "board";
export const hosts = ["careerspace.app"];

const FORMAT = { office: "офис", remote: "удалённо", hybrid: "гибрид" };
const LEVEL = { intern: "стажёр", junior: "младший специалист", specialist: "специалист", middle: "специалист", senior: "старший специалист", manager: "руководитель", lead: "тимлид", director: "директор" };

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (h !== "careerspace.app") return null;
  const m = u.pathname.match(/\/job\/(\d+)/);
  if (!m) return { error: "нужна ссылка на вакансию вида careerspace.app/job/<номер>" };
  return { id: m[1], url: `https://careerspace.app/job/${m[1]}`, slug: "careerspace-" + m[1] };
}

function findJobDetail(x, seen = new Set()) {
  if (!x || typeof x !== "object" || seen.has(x)) return null;
  seen.add(x);
  if (typeof x.job_name === "string" && typeof x.job_description === "string") return x;
  for (const v of Array.isArray(x) ? x : Object.values(x)) {
    const r = findJobDetail(v, seen);
    if (r) return r;
  }
  return null;
}

function salary(j) {
  if (!j.job_salary_from && !j.job_salary_to) return "";
  return [j.job_salary_from && `от ${j.job_salary_from}`, j.job_salary_to && `до ${j.job_salary_to}`].filter(Boolean).join(" ") + (j.job_salary_currency ? " " + j.job_salary_currency : "");
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const nuxt = kit.nuxtState(html);
  const j = nuxt && findJobDetail(nuxt);
  if (!j) throw new Error("на странице нет данных вакансии (__NUXT__)");

  const original = (j.job_contacts || []).find((c) => c.company_contact_type === "site" && /^https?:\/\//.test(c.company_contact_value || ""))?.company_contact_value;
  if (original) {
    try {
      const v = await kit.follow(original, name);
      if (v) return v;
    } catch {}
  }

  const cities = j.locations?.[0]?.cities || [];
  const location = cities[0]?.name || j.locations?.[0]?.name || "";
  const formats = (j.job_format || []).map((f) => FORMAT[f] || f);
  const contacts = (j.job_contacts || []).map((c) => `${c.company_contact_type}: ${c.company_contact_value}`).join("; ");

  const v = {
    title: j.job_name || "",
    company: j.company?.company_name || "",
    text: kit.htmlText(j.job_description || ""),
    method: "careerspace nuxt/" + via,
  };
  const sal = salary(j);
  if (sal) v.salary = sal;
  if (location) v.location = location;
  if (LEVEL[j.job_level]) v.experience = LEVEL[j.job_level];
  if (formats.length) v.work_format = formats.join(", ");
  if (j.published_at) v.date_posted = String(j.published_at).slice(0, 10);
  if (j.is_archive) v.archived = true;
  if (j.hh_response_letter_required) v.letter_required = true;
  if (contacts) v.contacts = contacts;
  return v;
}
