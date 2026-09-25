export const name = "gdtalents";
export const channel = "site";
export const hosts = ["gdtalents.com", "offerclaw.app"];

const EMPLOYMENT = { FULL_TIME: "полная", PART_TIME: "частичная", INTERN: "стажировка", CONTRACTOR: "проектная", TEMPORARY: "временная" };

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (!/(^|\.)(gdtalents\.com|offerclaw\.app)$/.test(h)) return null;
  const m = u.pathname.match(/\/vacancy\/([^/?#]+)/i);
  if (!m) return { error: "нужна ссылка на вакансию вида offerclaw.app/vacancy/<slug>" };
  return { id: m[1], url: `https://offerclaw.app/vacancy/${m[1]}`, slug: "gdtalents-" + m[1] };
}

function salaryText(jp) {
  const sal = jp.baseSalary?.value;
  if (!sal) return "";
  if (typeof sal.value === "string" && /\d/.test(sal.value)) return sal.value.trim();
  const cur = jp.baseSalary.currency || sal.currency || "";
  return [sal.minValue && `от ${sal.minValue}`, sal.maxValue && `до ${sal.maxValue}`].filter(Boolean).join(" ") + (cur ? " " + cur : "");
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const jp = kit.ldJobPosting(html);
  if (!jp) throw new Error("на странице нет описания вакансии (JobPosting)");
  const applyUrl = jp.identifier?.value || "";
  if (applyUrl) {
    try {
      const followed = await kit.follow(applyUrl, name);
      if (followed) return followed;
    } catch {}
  }
  const v = { ...kit.fromJobPosting(jp), method: "gdtalents ld+json/" + via };
  v.salary = salaryText(jp) || v.salary;
  v.employment = EMPLOYMENT[jp.employmentType] || v.employment;
  const og = kit.meta(html, "og:description");
  if (og) {
    const [ogLoc, ogLevel] = og.split("·").map((s) => s.trim());
    if (ogLoc) v.location = ogLoc;
    if (ogLevel) v.experience = ogLevel;
  }
  const metaBlock = html.match(/<div class="vacancy-meta">([\s\S]*?)<\/div>/);
  if (metaBlock) {
    const parts = kit.htmlText(metaBlock[1]).split("·").map((s) => s.trim()).filter(Boolean);
    if (parts[1] && !v.location) v.location = parts[1];
    if (parts[2]) v.work_format = parts[2];
  }
  return v;
}
