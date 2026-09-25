export const name = "example";
export const channel = "board";
export const hosts = ["example.ru"];

export function match(u) {
  if (u.hostname.replace(/^www\./, "") !== "example.ru") return null;
  const m = u.pathname.match(/\/vacancy\/(\d+)/);
  if (!m) return { error: "нужна ссылка на вакансию вида example.ru/vacancy/<номер>" };
  return { id: m[1], url: `https://example.ru/vacancy/${m[1]}`, slug: "example-" + m[1] };
}

export async function extract(src, kit) {
  const { html, via } = await kit.page(src.url);
  const jp = kit.ldJobPosting(html);
  const v = jp ? { ...kit.fromJobPosting(jp), method: "example ld+json/" + via } : { title: kit.meta(html, "og:title"), company: "", text: "", method: "example html/" + via };
  const state = kit.jsonBlobs(html).find((b) => /__NEXT_DATA__/.test(b.kind))?.data?.props?.pageProps?.vacancy;
  if (state) {
    v.title = state.title || v.title;
    v.company = state.company?.name || v.company;
    v.text = v.text || kit.htmlText(state.description || "");
    v.key_skills = (state.skills || []).map((s) => s.name).filter(Boolean);
  }
  if (!v.text) throw new Error("не найден текст вакансии");
  return v;
}

export async function search(query, opt, kit) {
  const cards = [];
  let total = 0;
  for (let p = 1; p <= (opt.maxPages || 10); p++) {
    const { data } = await kit.json(`https://example.ru/api/vacancies?q=${encodeURIComponent(query)}&page=${p}${opt.remoteOnly ? "&remote=1" : ""}`, { maxAgeDays: 0.25 });
    const list = data.items || [];
    if (p === 1) total = data.total || list.length;
    for (const x of list)
      cards.push({ id: String(x.id), url: `https://example.ru/vacancy/${x.id}`, title: x.title || "", company: x.company?.name || "", salary: x.salary || "", topRub: x.salary_to || null, remote: x.remote ?? null, exp: "", experience: "", responses: "", closed: false, letter: false, test: false });
    if (!list.length) break;
  }
  return { cards, total };
}
