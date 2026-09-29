// Scout's real web research. Brave Search if a key is set, otherwise DuckDuckGo's HTML search; Wikipedia either way.
// MOCK_WEB=1 skips the network entirely.
export type Source = { id: number; title: string; url: string; text: string };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 SYNTH-Scout";
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const unhtml = (x: string) => x.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function get(url: string, ms = 8000) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/json" }, signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

async function brave(q: string): Promise<Source[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`, {
    headers: { accept: "application/json", "x-subscription-token": process.env.BRAVE_API_KEY! }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`brave ${r.status}`);
  const j: any = await r.json();
  return (j.web?.results ?? []).slice(0, 6).map((x: any) => ({
    id: 0, title: clip(unhtml(x.title ?? ""), 120), url: x.url, text: clip(unhtml(`${x.description ?? ""} ${(x.extra_snippets ?? []).join(" ")}`), 700),
  }));
}

// No-key web search: DuckDuckGo's HTML endpoint (titles, snippets, real result URLs).
async function ddg(q: string): Promise<Source[]> {
  const html = await (await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`)).text();
  const out: Source[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    let url = m[1]!.replace(/&amp;/g, "&");
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]!);
    if (/duckduckgo\.com\/y\.js|ad_domain|bing\.com\/aclick/.test(url)) continue;   // skip ads
    out.push({ id: 0, title: clip(unhtml(m[2]!), 120), url, text: clip(unhtml(m[3]!), 500) });
    if (out.length >= 5) break;
  }
  return out;
}

// Always-available, no-key news: Hacker News stories about the company (Algolia API).
async function hn(company: string): Promise<Source[]> {
  const j: any = await (await get(`https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=20&numericFilters=created_at_i>1700000000&query=${encodeURIComponent(company)}`)).json();
  const namesake = /robinson|novel|transmeta|processor|defoe/i;
  const key = company.toLowerCase().split(".")[0]!;
  return (j.hits ?? []).filter((h: any) => h.url && (h.title?.toLowerCase().includes(key) || h.url.includes(company)) && !namesake.test(h.title)).slice(0, 4)
    .map((h: any) => ({ id: 0, title: clip(h.title, 120), url: h.url, text: clip(`${h.title}. Posted ${String(h.created_at).slice(0, 10)} on Hacker News (${h.points} points).`, 300) }));
}

async function wikipedia(company: string): Promise<Source | null> {
  // the company, not a namesake: the title must contain the name and the snippet must read like a business
  const s: any = await (await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=${encodeURIComponent(`${company} company`)}`)).json();
  const want = company.toLowerCase();
  const biz = /company|corporation|startup|founded|headquartered|provider|platform|cloud|software|inc\b/i;
  const title = (s?.query?.search ?? []).find((x: any) => x.title.toLowerCase().includes(want) && biz.test(x.snippet ?? "") && !/\((band|novel|film|album|song|musician|singer|TV series)\)/i.test(x.title))?.title as string | undefined;
  if (!title) return null;
  const j: any = await (await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)).json();
  return { id: 0, title: `Wikipedia: ${j.title}`, url: j.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`, text: clip(j.extract ?? "", 900) };
}

const MOCK_SOURCES = (c: string): Source[] => [
  { id: 1, title: `${c} — company overview`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(c)}`, text: `${c} is a technology company that builds developer infrastructure. It serves teams that run AI workloads and publishes an open API.` },
  { id: 2, title: `${c} homepage`, url: `https://www.${c.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`, text: `${c} helps companies ship faster with managed cloud services, a partner program, and a free tier for startups.` },
  { id: 3, title: `${c} partner program`, url: `https://www.${c.toLowerCase().replace(/[^a-z0-9]/g, "")}.com/partners`, text: `The ${c} partner program lists integration partners and co-marketing for tools that serve AI developers.` },
];

// the company's own site, when we know its domain (from the contact's email)
async function homepage(domain: string): Promise<Source | null> {
  const url = `https://${domain}`;
  const html = await (await get(url, 6000)).text();
  const pick = (re: RegExp) => html.match(re)?.[1] ?? "";
  const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i);
  if (/just a moment|attention required/i.test(title) || !(title || desc)) return null;
  return { id: 0, title: clip(unhtml(title) || domain, 120), url, text: clip(unhtml(desc), 500) };
}
const FREEMAIL = /^(gmail|googlemail|yahoo|hotmail|outlook|icloud|me|proton|protonmail|aol|live|msn|gmx)\./i;
export const domainOf = (email?: string) => { const d = email?.split("@")[1]?.toLowerCase(); return d && !FREEMAIL.test(d) && !/trusynth\.com$/.test(d) ? d : undefined; };

export async function research(company: string, domain?: string): Promise<{ sources: Source[]; via: string }> {
  if (process.env.MOCK_WEB === "1") return { sources: MOCK_SOURCES(company), via: "mock web" };
  const q = `${company} company news ${new Date().getFullYear()}`;
  const out: Source[] = [];
  const via: string[] = [];
  if (process.env.BRAVE_API_KEY) {
    try { const r = await brave(q); if (r.length) { out.push(...r); via.push("Brave Search"); } } catch {}
  }
  const [w, d, h, home] = await Promise.allSettled([wikipedia(company), out.length ? Promise.resolve([]) : ddg(domain ? `${q} ${domain}` : q), hn(domain ?? company), domain ? homepage(domain) : Promise.resolve(null)]);
  if (home.status === "fulfilled" && home.value) { out.unshift(home.value); via.push(domain!); }
  if (w.status === "fulfilled" && w.value) { out.unshift(w.value); via.push("Wikipedia"); }
  if (d.status === "fulfilled" && d.value.length) { out.push(...d.value); via.push("web search"); }
  if (out.length < 5 && h.status === "fulfilled" && h.value.length) { out.push(...h.value.slice(0, 6 - out.length)); via.push("Hacker News"); }
  if (!out.length) return { sources: MOCK_SOURCES(company), via: "fallback (web unreachable)" };
  return { sources: out.slice(0, 7).map((s, i) => ({ ...s, id: i + 1 })), via: via.join(" + ") };
}
