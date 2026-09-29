// Growth Synth: 5 companies from a public conference page that fit TRU Synth, each with a source, and one intro
// draft per company. Intros are Review cards of their own and stay drafts: nothing is ever sent from here.
// Traffic numbers need Similarweb access we don't have: the list says so instead of guessing.
import type { Executor } from "./types";
import { arrayOf, host, readPage, search } from "./web";

const EVENTS = [
  { q: "AI agents conference 2026 San Francisco sponsors", label: "an AI agents conference in San Francisco" },
  { q: "AI infrastructure summit 2026 sponsors exhibitors", label: "an AI infrastructure summit" },
];
const US = "TRU Synth makes Synths: AI workers that each get their own cloud computer, work in the background, and ask their owner before they act. Good fits: companies that build or run AI agents, agent infrastructure, developer tools for agents, and teams that need background automation with approvals.";

const growth: Executor = {
  synth: "growth", name: "Growth Synth", title: "Head of growth", kind: "growth", sponsors: ["Brave", "Crusoe", "Neo4j"],
  propose() { const e = EVENTS[Math.floor(Date.now() / 3.6e6) % EVENTS.length]!; return { task: `Find 5 companies at ${e.label} that fit us, with sources`, why: "Warm intros at events convert; each intro comes back to you as a draft.", input: e }; },
  async run(ctx) {
    const hits = await search(ctx, String(ctx.input.q), 8);
    // the event's own page first: sponsor / exhibitor / speaker lists
    let page: { url: string; title: string; text: string } | null = null;
    for (const h of hits.filter(h => !/wikipedia|medium\.com|linkedin/.test(h.host)).slice(0, 4)) {
      ctx.log(`Opening ${h.host}`);
      const r = await readPage(ctx, h.url, `Reading ${h.host}`, 9000);
      if (r && /sponsor|exhibitor|partner|speaker/i.test(r.text)) { page = { url: h.url, title: r.title || h.title, text: r.text }; break; }
    }
    if (!page) throw new Error("no public sponsor or speaker page loaded; not guessing a list");
    ctx.proof("source", { title: page.title, url: page.url, note: "the event page the companies come from" });
    await ctx.page.highlight("sponsors"); await ctx.shot(`The event page: ${host(page.url)}`);
    ctx.log("Picking the 5 best fits on Crusoe");
    type Pick = { company: string; why: string; line: string };
    const picks = arrayOf<Pick>(await ctx.think(
      `You pick sales targets. ${US} Only use companies named in the page text. Reply with a JSON array only.`,
      `Event page (${page.url}):\n${page.text.slice(0, 8000)}\n\nReturn the 5 companies that fit best: [{"company": "...", "why": "one plain sentence on the fit", "line": "the exact short phrase from the page that names them"}]`,
      { maxTokens: 3000 })).filter(p => p?.company && page!.text.toLowerCase().includes(p.company.toLowerCase().split(" ")[0]!)).slice(0, 5);
    if (!picks.length) throw new Error("the model named no company that is actually on the page");
    const rows: any[] = [];
    for (const p of picks) {
      ctx.log(`Looking up ${p.company}`);
      const site = (await search(ctx, `${p.company} official site`, 3).catch(() => []))[0];
      let about = "";
      if (site) { const r = await readPage(ctx, site.url, `${p.company}: ${site.host}`, 2500); if (r) { about = r.text.slice(0, 1500); ctx.proof("source", { title: `${p.company} (${site.host})`, url: site.url }); await ctx.shot(`${p.company}'s site`); } }
      rows.push({ company: p.company, fit: p.why, site: site?.url ?? "", traffic: "not available: no Similarweb access", about });
    }
    ctx.log("Writing one intro draft per company (drafts only)");
    type Intro = { company: string; subject: string; body: string };
    const intros = arrayOf<Intro>(await ctx.think(
      `You write short intro emails from George Trushevskiy, founder of TRU Synth. ${US} Max 90 words each, plain, specific, one ask (a 15 minute call). Start with "Hi ${"${company}"} team,". No placeholders, no em dashes, no emoji. Reply with a JSON array only.`,
      rows.map(r => `${r.company}: ${r.fit}\nTheir site says: ${r.about.slice(0, 600)}`).join("\n\n") + `\n\nReturn [{"company": "...", "subject": "...", "body": "..."}] with one item per company.`,
      { maxTokens: 3000 })).filter(i => i?.company && i.body && !/\[|\{|your name/i.test(i.body)).slice(0, 5);
    intros.forEach((it, n) => ctx.proof("intro", { n: n + 1, company: it.company, subject: it.subject.replace(/\s*[—–]\s*/g, ", "), body: `${it.body.replace(/\s*[—–]\s*/g, ", ").trim()}\n\nGeorge Trushevskiy\nFounder, TRU Synth, trusynth.com`, sent: false }));
    ctx.proof("result", { title: `5 fits from ${host(page.url)}`, lines: rows.map(r => `${r.company}: ${r.fit}${r.site ? ` (${host(r.site)})` : ""}. Traffic: ${r.traffic}.`), rows: rows.map(({ about, ...r }) => r) });
    return `${rows.length} companies with sources, ${intros.length} intro drafts waiting for you (nothing sent).`;
  },
};
export default growth;
