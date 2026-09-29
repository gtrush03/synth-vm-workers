// Shared read-only web moves for TEAM executors: a Brave search in the Synth's own browser, and reading a page.
import type { TaskCtx } from "./types";

export type Hit = { title: string; url: string; host: string };
const SKIP = /youtube\.com|youtu\.be|brave\.com|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|linkedin\.com\/(posts|feed)|reddit\.com\/r\/[^/]+\/comments/i;
export const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// Bing wraps results in /ck/a?...&u=a1<base64url of the real url>
const unwrap = (u: string) => {
  if (!/bing\.com\/ck\/a/.test(u)) return u;
  const m = /[?&]u=a1([^&]+)/.exec(u); if (!m) return "";
  try { return Buffer.from(m[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
};
async function engine(ctx: TaskCtx, name: "Brave" | "Bing", q: string) {
  const u = name === "Brave" ? `https://search.brave.com/search?q=${encodeURIComponent(q)}` : `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
  ctx.log(`Searching ${name} for "${q}"`);
  if (!await ctx.page.goto(u, `${name}: ${q}`.slice(0, 80))) return [];
  await Bun.sleep(1500);
  const txt = (await ctx.page.read(800)).text;
  if (/confirm you are human|security check|captcha|unusual traffic/i.test(txt)) { ctx.log(`${name} asked for a bot check; not solving it`); return []; }
  await ctx.shot(`${name} results for "${q}"`);
  const sel = name === "Bing" ? "#b_results h2 a" : "a[href^='http']";
  const raw: { url: string; text: string }[] = await ctx.page.evaluate(`() => [...document.querySelectorAll("${sel}")].map(a => ({ url: a.href, text: a.innerText.trim() })).filter(a => a.text.length > ${name === "Bing" ? 8 : 20})`) ?? [];
  return raw.map(r => ({ ...r, url: unwrap(r.url) })).filter(r => r.url.startsWith("http") && !/bing\.com|microsoft\.com\/(en-us\/)?bing/.test(r.url));
}

export async function search(ctx: TaskCtx, q: string, n = 8): Promise<Hit[]> {
  let raw = await engine(ctx, "Brave", q);
  if (raw.length < 3) raw = await engine(ctx, "Bing", q);
  const seen = new Set<string>(), out: Hit[] = [];
  for (const r of raw) {
    const h = host(r.url);
    if (!h || SKIP.test(r.url) || seen.has(r.url.split("#")[0]!)) continue;
    seen.add(r.url.split("#")[0]!);
    const lines = r.text.split("\n").map(s => s.trim()).filter(Boolean);
    out.push({ url: r.url, host: h, title: (lines.find(l => l.length > 25 && !l.includes("›")) ?? lines.at(-1) ?? h).slice(0, 140) });
    if (out.length >= n) break;
  }
  if (!out.length) throw new Error("neither Brave nor Bing returned usable results");
  await ctx.page.scroll(500);
  return out;
}

export async function readPage(ctx: TaskCtx, url: string, caption: string, max = 5000) {
  if (!await ctx.page.goto(url, caption.slice(0, 80))) return null;
  await ctx.page.scroll(400);
  const r = await ctx.page.read(max);
  return r.text.length > 200 ? r : null;
}

export const jsonOf = <T>(s: string): T | null => {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, s];
  const t = m[1]!.trim(), i = Math.min(...["[", "{"].map(c => t.indexOf(c)).filter(x => x >= 0));
  try { return JSON.parse(t.slice(i === Infinity ? 0 : i)); } catch { return null; }
};

// a JSON array from a model answer, also when it came wrapped in an object ({"items": [...]})
export const arrayOf = <T>(s: string): T[] => {
  const j: any = jsonOf<any>(s);
  if (Array.isArray(j)) return j;
  if (j && typeof j === "object") for (const v of Object.values(j)) if (Array.isArray(v)) return v as T[];
  const m = s.match(/\[[\s\S]*\]/); try { return m ? JSON.parse(m[0]) : []; } catch { return []; }
};
