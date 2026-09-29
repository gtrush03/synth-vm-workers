// Research Synth: a sourced brief. Brave search → opens each site → outlines the fact it takes. Every line links its source.
import type { Executor } from "./types";
import { arrayOf, host, readPage, search } from "./web";

const TOPICS = [
  { q: "alternatives to Band for AI agent chat rooms multi-agent", task: "Brief: 3 alternatives to Band for agent rooms, with sources", why: "We build on Band; if the free tier's 5-seat room cap bites, we should know the options." },
  { q: "managed LLM inference providers open models pricing 2026", task: "Brief: 3 inference providers that could back up Crusoe, with sources", why: "One provider is one point of failure for every Synth's thinking." },
];

const research: Executor = {
  synth: "research", name: "Research Synth", title: "Research lead", kind: "brief", sponsors: ["Brave", "Crusoe", "Neo4j"],
  propose() { const t = TOPICS[Math.floor(Date.now() / 3.6e6) % TOPICS.length]!; return { task: t.task, why: t.why, input: { q: t.q, ask: t.task } }; },
  async run(ctx) {
    const q = String(ctx.input.q), ask = String(ctx.input.ask ?? q);
    const hits = await search(ctx, q, 8);
    const pages: { url: string; title: string; text: string }[] = [];
    for (const h of hits) {
      if (pages.length >= 4) break;
      ctx.log(`Reading ${h.host}`);
      const r = await readPage(ctx, h.url, `Reading ${h.host}`);
      if (!r) { ctx.log(`${h.host} did not load; skipping it`); continue; }
      pages.push({ url: h.url, title: r.title || h.title, text: r.text });
      ctx.proof("source", { title: r.title || h.title, url: h.url });
    }
    if (pages.length < 2) throw new Error(`only ${pages.length} source page(s) loaded; not enough for an honest brief`);
    ctx.log(`Writing the brief from ${pages.length} pages on Crusoe`);
    const sys = "You write short research briefs. Use ONLY the page texts given. Every item must cite the page it came from and quote a short exact phrase from that page as evidence. Reply with a JSON array only, no prose.";
    const prompt = `Task: ${ask}\n\n${pages.map((p, i) => `[${i}] ${p.title} (${p.url})\n${p.text.slice(0, 3000)}`).join("\n\n")}\n\nReturn [{"name": "...", "what": "one plain sentence", "evidence": "a short exact phrase from the page", "src": <page index>}] with exactly 3 items, drawn from at least 2 different pages.`;
    type It = { name: string; what: string; evidence?: string; src: number };
    let items = arrayOf<It>(await ctx.think(sys, prompt, { maxTokens: 3000 })).filter(x => x?.name && pages[Number(x.src)]).slice(0, 3);
    if (!items.length) { ctx.log("First answer did not parse; asking a second Crusoe model"); items = arrayOf<It>(await ctx.think(sys, prompt, { maxTokens: 3000, model: "openai/gpt-oss-120b" })).filter(x => x?.name && pages[Number(x.src)]).slice(0, 3); }
    if (!items.length) throw new Error("the model returned no usable brief");
    // show the evidence: back to each source, the phrase outlined
    for (const it of items) {
      const p = pages[Number(it.src)]!;
      ctx.log(`Checking "${it.name}" on ${host(p.url)}`);
      if (await ctx.page.goto(p.url, `Evidence for ${it.name}`.slice(0, 80))) {
        const hit = await ctx.page.highlight(it.evidence || it.what) || await ctx.page.highlight(it.name);
        await ctx.shot(`${it.name}: ${hit ? "the line it comes from" : "the page it comes from"}`);
      }
    }
    ctx.proof("result", { title: ask, lines: items.map(it => `${it.name}: ${it.what} (${host(pages[Number(it.src)]!.url)})`), rows: items.map(it => ({ name: it.name, what: it.what, evidence: it.evidence ?? "", source: pages[Number(it.src)]!.url })) });
    return `Brief ready: ${items.map(i => i.name).join(", ")}, ${pages.length} sources.`;
  },
};
export default research;
