import { slugify } from "../lib.mjs";

export const name = "telegram";
export const channel = "telegram";
export const hosts = ["t.me"];

export function match(u) {
  const h = u.hostname.replace(/^www\./, "");
  if (h !== "t.me" && h !== "telegram.me") return null;
  const m = u.pathname.match(/^\/(?:s\/)?([A-Za-z0-9_]{4,})\/(\d+)/);
  if (m) return { id: `${m[1]}/${m[2]}`, url: `https://t.me/${m[1]}/${m[2]}`, slug: `tg-${slugify(m[1], 30)}-${m[2]}` };
  return { slug: "tg-" + (slugify(u.pathname, 30) || "link"), error: "нужна ссылка на пост вида t.me/<канал>/<номер>; приватные каналы (t.me/+..., t.me/c/...) недоступны" };
}

export async function extract(src, kit) {
  const [ch, id] = String(src.id).split("/");
  const { html, via } = await kit.page(`https://t.me/${ch}/${id}?embed=1`, { allowBrowser: false });
  const post = html.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (!post) throw new kit.NetError("telegram: пост не отдан, канал приватный или пост удалён");
  const owner = html.match(/tgme_widget_message_owner_name[^>]*>([\s\S]*?)<\/a>/);
  const text = kit.htmlText(post[1]);
  return { title: text.split("\n").find((l) => l.trim()).slice(0, 90), company: "", channel_name: owner ? kit.htmlText(owner[1]) : ch, text, method: "telegram embed/" + via };
}
