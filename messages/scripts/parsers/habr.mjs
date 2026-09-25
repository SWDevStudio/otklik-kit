export const name = "habr";
export const channel = "habr_career";
export const hosts = ["career.habr.com"];

export function match(u) {
  const m = u.hostname.replace(/^www\./, "") === "career.habr.com" && u.pathname.match(/\/vacancies\/(\d+)/);
  return m ? { id: m[1], url: `https://career.habr.com/vacancies/${m[1]}`, slug: "habr-" + m[1] } : null;
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const jp = kit.ldJobPosting(html);
  if (!jp) throw new Error("на странице нет описания вакансии (JobPosting)");
  const v = { ...kit.fromJobPosting(jp), method: "habr ld+json/" + via };
  const ds = html.match(/<script[^>]*data-ssr-state="true"[^>]*>([\s\S]*?)<\/script>/);
  if (ds) {
    try {
      const vac = JSON.parse(ds[1]).vacancy || {};
      if (vac.salary?.formatted) v.salary = vac.salary.formatted;
      v.key_skills = (vac.skills || []).map((x) => x.title).filter(Boolean);
      if (vac.qualification) v.experience = vac.qualification;
      if (vac.remoteWork) v.work_format = "удалённо";
      if (vac.humanCityNames?.length) v.location = vac.humanCityNames.join(", ");
      v.archived = !!vac.archived;
    } catch {}
  }
  return v;
}
