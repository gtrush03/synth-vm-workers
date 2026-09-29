// What each worker does when it is @mentioned in the room. No worker calls another directly: every handoff is a
// room message, and each worker only knows what the room told it.
import { think, json, MODEL, type LlmResult } from "./llm";
import { domainOf, research, type Source } from "./research";
import type { Handler, RoomCtx } from "./room";
import { makeEye, views, webSearch } from "./browser";

export type Role = string;   // Scout | Echo | Chief | a checker (FactCheck, PartnerCheck, Pricing, Tech, Legal, Scheduler)
export type Report = (kind: string, data: Record<string, unknown>) => void;
export type Workspace = { write(name: string, body: string): Promise<void> };

type Fact = { fact: string; src: number };
type Check = { claim: string; supported: boolean; src?: number | null; note?: string };
type Draft = { subject: string; body: string };
export type Line = { id: number; speaker: string; t: string; text: string };
export type Scribe = { summary: string; needs: string[]; commitments: { text: string; owner: string; due?: string; line?: number }[];
  quote?: { line: number; text: string }; topic: string; flags: { pricing?: boolean; tech?: boolean; legal?: boolean; meeting?: boolean } };

// what each specialist is for, and the words in a conversation that call for it
export const SPECIALISTS: Record<string, { focus: string; when: keyof Scribe["flags"] | null }> = {
  Pricing: { focus: "prices, discounts, costs and budget numbers", when: "pricing" },
  Tech: { focus: "technical claims: integrations, APIs, performance, architecture", when: "tech" },
  Legal: { focus: "contract, compliance, data and privacy promises", when: "legal" },
  Scheduler: { focus: "dates, times and proposed meetings", when: "meeting" },
  PartnerCheck: { focus: "every factual claim, as an independent checker from another organisation", when: null },
  FactCheck: { focus: "every factual claim", when: null },
};
export const isChecker = (r: string) => r in SPECIALISTS;

const srcList = (s: Source[]) => s.map(x => `[${x.id}] ${x.title}${x.url ? ` (${x.url})` : ""}: ${x.text}`).join("\n");
const MAX_VERSIONS = 3;
// Who the email is from. Source 0 is the sender's own fact sheet, so claims about TRU Synth are checkable too.
const SENDER = { name: "George Trushevskiy", title: "Founder, TRU Synth", site: "trusynth.com" };
const SENDER_SOURCE: Source = { id: 0, title: "TRU Synth fact sheet (sender)", url: "https://trusynth.com",
  text: "TRU Synth makes Synths: AI workers that each get their own cloud computer, work in the background, and ask their owner before they act (send, post, pay). Available as an iPhone and Mac app. Founder: George Trushevskiy. TRU Synth does NOT sell inference, compute or data centers. The code for SYNTH: VM Workers (the multi-agent Deal Room): https://github.com/gtrush03/synth-vm-workers" };
// things George may promise to send, and the real link for each (never invent one)
const PROMISED: [RegExp, string][] = [[/\b(the |our )?(code|repo|github|source)\b/i, "https://github.com/gtrush03/synth-vm-workers"]];
const promisedLinks = (lines: Line[] = []) => [...new Set(lines.filter(l => /george/i.test(l.speaker)).flatMap(l => PROMISED.filter(([re]) => re.test(l.text)).map(([, u]) => u)))];
// fix near-miss spellings of the company name ("Crusave" → "Crusoe"); the model's typos never reach an inbox
function fixName(text: string, company: string) {
  const c = company.trim(), lc = c.toLowerCase();
  if (c.length < 4) return text;
  const dist = (a: string, b: string) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length]![b.length]!; };
  return text.replace(/\b[A-Z][a-zA-Z]{2,}\b/g, w => w.toLowerCase() !== lc && w.slice(0, 3).toLowerCase() === lc.slice(0, 3) && Math.abs(w.length - c.length) <= 2 && dist(w.toLowerCase(), lc) <= 2 ? c : w);
}
export const SIGNATURE = `${SENDER.name}\n${SENDER.title}, ${SENDER.site}`;
// transcript lines are evidence too: source ids 100+ are "what was said, by whom, when"
export const lineSources = (lines: Line[] = []): Source[] =>
  lines.map(l => ({ id: 100 + l.id, title: `Conversation ${l.t} · ${l.speaker}`, url: "", text: l.text }));
const FILLER = /\b(synerg\w*|industry[- ]leading|cutting[- ]edge|best[- ]in[- ]class|world[- ]class|revolutioni[sz]\w*|game[- ]chang\w*|seamless(ly)?|unlock\w*|leverag\w*)\b/gi;
// hard checks Chief applies whatever its model says: placeholders, filler, length
function lint(d: Draft): Check[] {
  const out: Check[] = [];
  for (const m of `${d.subject}\n${d.body}`.match(/\[[^\]]*\]|\{[^}]*\}|<[^>]*>|\byour (name|title|company)\b|contact information|dear sir|to whom it may concern/gi) ?? [])
    out.push({ claim: m, supported: false, note: "placeholder: an unfilled template can never ship" });
  if (/\b(exploring|opportunit\w*|collaboration|partnership)\b/i.test(d.subject) && !/\d/.test(d.subject) && !/follow/i.test(d.subject))
    out.push({ claim: `subject "${d.subject}"`, supported: false, note: "generic subject: lead with something specific" });
  for (const m of new Set((`${d.subject} ${d.body}`.match(FILLER) ?? []).map(x => x.toLowerCase()))) out.push({ claim: m, supported: false, note: "filler word, say something concrete" });
  const words = d.body.split(/\s+/).length;
  if (words > 160) out.push({ claim: `${words} words`, supported: false, note: "too long, keep it under 130 words" });
  return out;
}
// George sees no em dashes and no emoji
const plain = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").replace(/ ,/g, ",");

export function makeRole(role: Role, report: Report, ws: Workspace): Handler {
  const status = (s: string, detail = "") => report("status", { status: s, detail });
  const eye = makeEye(role, report);   // this worker's live browser on the wall (read-only; SYNTH_FRAMES=1)
  // what its tile shows between jobs: a page that fits the role, never a blank tile
  eye.run(async () => {
    if (role === "Scout") await eye.goto("https://news.ycombinator.com", "Standing by: ready for the next company");
    else if (role === "Echo") await eye.view("compose", views.compose("(next contact)", "(waiting for Scout's research)"), "Standing by: empty compose, waits for Scout");
    else if (role === "Chief") await (process.env.SERVER_URL?.startsWith("http://localhost") ? eye.goto(`${process.env.SERVER_URL}/graph`, "Standing by: the deal graph it checks against") : eye.view("transcript", views.transcript([], [], "No conversation yet"), "Standing by"));
    else if (role === "Counterparty") await eye.view("calendar", views.calendar("The other company's agent · calendar", [{ day: 1, from: 8, to: 18 }, { day: 2, from: 9, to: 12 }, { day: 3, from: 13, to: 16 }], undefined, "Free/busy only. Waits for Chief to ask about the commitments."), "Standing by: its own calendar (free/busy)");
    else if (role === "Scheduler") await eye.view("calendar", views.calendar("Scheduler · next week", [], undefined, "No calendar connected: slots come from the conversation and the other side's answer."), "Standing by: next week, free/busy only");
    else await eye.view("standby", views.standby(role, SPECIALISTS[role]?.focus ?? "claims", ["Chief recruits it by what the conversation was about", "It opens each claim's source in this browser", "Found: outlined in champagne. Not found: marked red", "It reports to Chief, then Chief dismisses it"]), "Standing by: waits for Chief to recruit it");
  });
  const llm = async (label: string, r: Promise<LlmResult>) => {
    const x = await r;
    report("llm", { label, provider: x.provider, model: x.model, ms: x.ms, tokens: x.tokens, inTokens: x.inTokens, outTokens: x.outTokens, fallbacks: x.fallbacks ?? [] });
    return x.text;
  };
  const ev = (ctx: RoomCtx, kind: Parameters<RoomCtx["event"]>[0], text: string) => {
    report("event", { roomId: ctx.roomId, eventKind: kind, text });
    return ctx.event(kind, text);
  };
  // `graph` rides along in telemetry only (the server records it into Neo4j); the room gets the payload
  const sent = (ctx: RoomCtx, text: string, mentions: string[], payload?: unknown, tone = "", graph?: unknown) => {
    report("sent", { roomId: ctx.roomId, text, mentions, tone, issues: (payload as any)?.issues, graph });
    return ctx.send(text, mentions, payload);
  };

  if (role === "Scout") return async (m, ctx) => {
    if (!m.payload?.company) return;
    const { company, task, to, who, lines, scribe } = m.payload as { company: string; task: string; to?: string; who?: string; lines?: Line[]; scribe?: Scribe };
    status("working", `researching ${company}`);
    eye.run(async () => { await webSearch(eye, company, `Searching the web for ${company}`); await eye.scroll(600); });
    await ev(ctx, "tool_call", `web.research("${company}"${domainOf(to) ? `, "${domainOf(to)}"` : ""})`);
    const { sources, via } = await research(company, domainOf(to));
    await ws.write("sources.json", JSON.stringify(sources, null, 1));
    await ev(ctx, "tool_result", `${sources.length} sources via ${via}`);
    report("file", { name: "sources.json", detail: `${sources.length} sources via ${via}` });
    const angle = scribe ? `They care about: ${[scribe.topic, ...scribe.needs].join("; ")}.` : "";
    const text = await llm("brief", think([
      { role: "system", content: "You are Scout, a research worker. Only state what the sources say, and only about the company itself: ignore results about anything else that shares its name (books, people, old products). Reply with JSON only." },
      { role: "user", content: `Task: ${task}\n${angle}\nSources:\n${srcList(sources)}\n\nReturn a JSON array of 4-6 short, specific facts (numbers, launches, customers, news) useful for a follow-up to ${company}: [{"fact": "...", "src": <source id>}]` },
    ], { maxTokens: 700, mock: () => JSON.stringify(sources.slice(0, 3).map(s => ({ fact: s.text.split(". ")[0] + ".", src: s.id }))) }));
    const facts = (json<Fact[]>(text) ?? []).filter(f => f?.fact && sources.some(s => s.id === Number(f.src)));
    await ws.write("brief.md", facts.map(f => `- ${f.fact} [${f.src}]`).join("\n"));
    // the pages behind the facts it actually took, homepage first, each fact outlined where the page says it
    eye.run(async () => {
      const used = sources.filter(x => x.url && facts.some(f => Number(f.src) === x.id)).sort((a, b) => Number(/news|article|ycombinator|reuters|techcrunch/i.test(a.url!)) - Number(/news|article|ycombinator|reuters|techcrunch/i.test(b.url!))).slice(0, 3);
      for (const x of used) {
        const f = facts.find(f => Number(f.src) === x.id)!;
        if (!await eye.goto(x.url!, `Reading ${x.title}`)) continue;
        if (!await eye.highlight(f.fact) && !await eye.highlight(x.text.slice(0, 200))) await eye.scroll(700);
      }
    });
    status("handed off", `${facts.length} facts → Echo`);
    await sent(ctx, `@Echo research on ${company} is in: ${facts.length} facts from ${sources.length} sources (${via}).\n` +
      facts.map(f => `• ${f.fact} [${f.src}]`).join("\n"), ["Echo"], { company, task, to, who, facts, sources, lines, scribe }, "", { sources });
    status("idle");
  };

  if (role === "Echo") {
    type St = { company: string; to?: string; who?: string; task: string; facts: Fact[]; sources: Source[]; lines?: Line[]; scribe?: Scribe; version: number; draft?: Draft };
    const rooms = new Map<string, St>();
    return async (m, ctx) => {
      let st = rooms.get(m.roomId);
      if (m.from === "Scout" && m.payload?.facts) {
        st = { ...m.payload, sources: [SENDER_SOURCE, ...m.payload.sources, ...lineSources(m.payload.lines)], version: 0 };
        rooms.set(m.roomId, st!);
      } else if (m.from === "Chief" && (m.payload?.veto || m.payload?.update) && st) {
        // a block or a plan change from the other side: revise below
      } else if (m.from === "Desk" && m.payload?.ship) {
        // Echo may not ship. Only Desk ships, and only after George says yes.
        await ev(ctx, "error", "Echo has no ship permission: drafts go to Chief, shipping is Desk's after George's yes");
        return;
      } else return;
      const s = st!;
      s.version++;
      status("working", s.version === 1 ? "drafting v1" : `revising after BLOCKED → v${s.version}`);
      const brief = s.facts.map(f => `- ${f.fact} [${f.src}]`).join("\n");
      const convo = s.lines?.length ? `\n\nThe conversation (quote at most one line, word for word):\n${s.lines.map(l => `[${100 + l.id}] ${l.t} ${l.speaker}: ${l.text}`).join("\n")}` +
        (s.scribe ? `\nScribe's notes: topic "${s.scribe.topic}"; needs: ${s.scribe.needs.join("; ") || "none"}; commitments: ${s.scribe.commitments.map(c => `${c.owner}: ${c.text}${c.due ? ` (${c.due})` : ""}`).join("; ") || "none"}` : "") : "";
      const name = s.who ? s.who.split(" ")[0] : `${s.company} team`;
      const ask = s.version === 1
        ? (s.lines?.length
          ? `Write the follow-up email from ${SENDER.name} to ${s.who ?? "them"} at ${s.company}, after the conversation above. Max 120 words. Open by referencing what they said (one short quote). Use one specific fact from Scout's research about ${s.company}. Restate each commitment plainly.${promisedLinks(s.lines).length ? ` George promised to send something: include this exact link for it: ${promisedLinks(s.lines).join(" ")}.` : ""} End with one concrete next step. Subject: "Following up on <topic>". Never present ${s.company}'s products as TRU Synth's. Be specific and bold.`
          : `Write a short outreach email from ${SENDER.name} to ${s.company}. Max 120 words. Open with one sharp hook using a real fact about ${s.company}. One sentence on TRU Synth. One concrete ask (a 15-minute call). Be specific and bold.`)
        : m.payload?.update
        ? `The other company's agent answered: ${m.payload.update}\n\nPrevious draft:\n${s.draft!.body}\n\nUpdate the email to match exactly (new time, new attendees), keep everything else. Max 120 words.`
        : `Chief BLOCKED your draft v${s.version - 1}. Missing evidence:\n${(m.payload.issues as Check[]).map(i => `- "${i.claim}": ${i.note ?? "not supported by any finding or transcript line"}`).join("\n")}\n\nPrevious draft:\n${s.draft!.body}\n\nRewrite it: fix or cut every flagged item, keep everything else. Use only facts from the brief and the conversation. Max 120 words.`;
      const text = await llm(`draft v${s.version}`, think([
        { role: "system", content: `You are Echo, who writes emails for ${SENDER.name}. Start with "Hi ${name}," and END right after the next step: do NOT sign, the signature is added automatically. No placeholders or brackets, no source markers like [1], no em dashes, no emoji. Reply with JSON only: {"subject": "...", "body": "..."}` },
        { role: "user", content: `Research brief (facts with source ids):\n${brief}\n[0] ${SENDER_SOURCE.text}${convo}\n\n${ask}` },
      ], { maxTokens: 900, mock: () => JSON.stringify(s.version === 1
        ? { subject: `Following up from today, ${s.company}`, body: `Hi ${name},\n\n${s.facts[0]?.fact ?? ""} TRU Synth gives every AI worker its own computer, and we're already trusted by 40,000 teams. Open to a 15-minute call next week?` }
        : { subject: `Following up from today, ${s.company}`, body: `Hi ${name},\n\n${s.facts[0]?.fact ?? ""} TRU Synth gives every AI worker its own computer, and it asks before it acts. Open to a 15-minute call next week?` }) }));
      const raw = json<Draft>(text) ?? { subject: `Following up, ${s.company}`, body: text };
      // the signature is code, not model output: it can never come out as "[Your Name]"
      const body = fixName(plain(raw.body), s.company).replace(/\s*\((source|src)\s*\[?\d+\]?\)|\s*\[\d+\]/gi, "").replace(/\n+(best|regards|cheers|thanks|sincerely|warm regards|best regards|all the best)[,.!]?\s*(\n[^\n]{0,60}){0,3}\s*$/i, "").trim();
      if (body.split(/\s+/).length < 15) throw new Error(`Echo's v${s.version} came back empty; retrying is safer than sending a stub`);
      let subject = fixName(plain(raw.subject), s.company).trim();
      if (s.lines?.length && !/follow/i.test(subject)) subject = `Following up on ${s.scribe?.topic ?? subject}`;
      const d: Draft = { subject, body: `${body}\n\n${SIGNATURE}` };
      s.draft = d;
      await ws.write(`draft-v${s.version}.md`, `# ${d.subject}\n\n${d.body}\n`);
      eye.run(async () => { await eye.view("compose", views.compose(s.who ? `${s.who} at ${s.company}` : s.company, d.subject), `Writing draft v${s.version}${m.payload?.update ? " to the other side's answer" : ""}`); await eye.type("#body", d.body, 90); });
      report("file", { name: `draft-v${s.version}.md`, detail: d.subject });
      status("waiting", `v${s.version} with Chief`);
      await sent(ctx, `@Chief draft v${s.version} for review${m.payload?.update ? " (updated to the other side's answer)" : ""}:\n**${d.subject}**\n${d.body}`, ["Chief"],
        { company: s.company, to: s.to, who: s.who, version: s.version, draft: d, sources: s.sources, facts: s.facts, scribe: s.scribe, updated: !!m.payload?.update });
    };
  }

  if (isChecker(role)) return async (m, ctx) => {
    if (m.from !== "Chief" || !m.payload?.draft) return;
    const { draft, sources, version } = m.payload as { draft: Draft; sources: Source[]; version: number };
    const focus = SPECIALISTS[role]!.focus;
    status("working", `checking v${version}`);
    const text = await llm(`check v${version}`, think([
      { role: "system", content: `You are ${role}, a checker recruited into this room for ${focus}. Be strict: a claim is supported ONLY if a source or a conversation line [100+] says it. Numbers, customer counts, rankings, dates and promises need an exact match. Reply with JSON only.` },
      { role: "user", content: `Sources and conversation lines:\n${srcList(sources)}\n\nDraft:\n${draft.body}\n\nList every factual claim in the draft (skip the greeting and signature): [{"claim": "...", "supported": true|false, "src": <id or null>, "note": "why"}]` },
    ], { maxTokens: 900, mock: () => JSON.stringify([
      { claim: draft.body.split("\n\n")[1]?.split(". ")[0] ?? "company description", supported: true, src: 1, note: "matches source 1" },
      ...(draft.body.includes("40,000") ? [{ claim: "trusted by 40,000 teams", supported: false, src: null, note: "no source or transcript line mentions this number" }] : []),
    ]) }));
    let checks = (json<Check[]>(text) ?? []).filter(c => c?.claim);
    if (!checks.length) {   // one retry with a blunter instruction before giving up
      const again = await llm(`check v${version} (retry)`, think([
        { role: "system", content: `You are ${role}. Output ONLY a JSON array, nothing else.` },
        { role: "user", content: `Sources:\n${srcList(sources)}\n\nDraft:\n${draft.body}\n\n[{"claim": "...", "supported": true|false, "src": <id or null>, "note": "why"}]` },
      ], { model: "deepseek-ai/Deepseek-V4-Flash", maxTokens: 900 }));
      checks = (json<Check[]>(again) ?? []).filter(c => c?.claim);
    }
    if (!checks.length) throw new Error(`${role} could not parse any claims from its model's answer`);
    const bad = checks.filter(c => !c.supported);
    eye.run(async () => {
      const lines = sources.filter(x => x.id >= 100).map(x => ({ id: x.id, t: x.title.replace(/^Conversation\s+/, "").split(" · ")[0] ?? "", speaker: x.title.split(" · ")[1] ?? "", text: x.text }));
      for (const c of [...bad.slice(0, 2), ...checks.filter(c => c.supported).slice(0, 2)]) {
        const x = c.src == null ? undefined : sources.find(y => y.id === Number(c.src));
        if (x && x.id >= 100) await eye.view("transcript", views.transcript(lines, c.supported ? [x.id] : [], "The conversation", c.supported ? [] : [x.id]), `${c.supported ? "Found" : "Not in"} the conversation: "${c.claim.slice(0, 80)}"`);
        else if (x?.url && await eye.goto(x.url, `Opening the source for "${c.claim.slice(0, 80)}"`)) {
          const hit = await eye.highlight(c.claim, c.supported ? "found" : "notfound");
          eye.mark(hit && c.supported ? "found" : "notfound", `${hit && c.supported ? "Found" : "Not found"} on ${x.title}: ${c.claim}`);
        } else if (!c.supported) {
          await eye.view("transcript", views.transcript(lines, []), `No source says: "${c.claim.slice(0, 80)}"`);
          eye.mark("notfound", `No source or conversation line says: ${c.claim}`);
        }
      }
    });
    await ws.write(`checks-v${version}.json`, JSON.stringify(checks, null, 1));
    status("handed off", `${checks.length} claims, ${bad.length} unsupported`);
    await sent(ctx, `@Chief ${role} checked ${checks.length} claims in v${version}: ${checks.length - bad.length} supported, ${bad.length} unsupported` +
      (bad.length ? `:\n${bad.map(b => `✗ "${b.claim}" (${b.note ?? "no source"})`).join("\n")}` : "."), ["Chief"], { version, checks }, "", { checks, version });
    status("idle");
  };

  // The other company's agent, on a second Band account: it only ever sees the commitments, never research or drafts.
  if (role === "Counterparty") return async (m, ctx) => {
    if (m.from !== "Chief" || !m.payload?.commitments) return;
    const { commitments, company } = m.payload as { commitments: { text: string; owner: string; due?: string; said?: string }[]; company: string };
    status("working", `checking ${commitments.length} commitments`);
    const own = process.env.COUNTERPARTY_CONTEXT ?? "Your principal's calendar next week: Tuesday is fully booked; Wednesday 2:30 PM PT is free. Any technical follow-up should include your CTO.";
    const text = await llm("confirm", think([
      { role: "system", content: `You are the agent for ${company} (the other side of the deal), on your own Band account. You see only the commitments below. Your own private context: ${own}\nConfirm what matches. Only object to material things: a date or time that doesn't work, a missing attendee, a wrong owner. Ignore wording. Reply with JSON only: {"confirmed": ["..."], "change": "one sentence proposing the change, or empty"}` },
      { role: "user", content: commitments.map((c, i) => `${i + 1}. ${c.owner}: ${c.text}${c.due ? ` (due ${c.due})` : ""}${c.said ? `\n   said: "${c.said}"` : ""}`).join("\n") },
    ], { maxTokens: 600, mock: () => JSON.stringify({ confirmed: commitments.map(c => c.text), change: "Wednesday 2:30 PM PT works better than Tuesday. Please add our CTO." }) }));
    const res = json<{ confirmed?: string[]; change?: string }>(text) ?? { confirmed: commitments.map(c => c.text) };
    const change = (res.change ?? "").trim();
    // its own calendar, from its own private context (free/busy only)
    eye.run(async () => {
      const wed = /wed[a-z]*\s+(\d{1,2})(?::(\d\d))?\s*(am|pm)/i.exec(own);
      const at = wed ? (Number(wed[1]) % 12) + (/pm/i.test(wed[3]!) ? 12 : 0) + Number(wed[2] ?? 0) / 60 : 14.5;
      await eye.view("calendar", views.calendar(`${company}'s agent · calendar`, [{ day: 1, from: 8, to: 18 }, { day: 2, from: 9, to: 12 }, { day: 3, from: 13, to: 16 }],
        { day: 2, at, label: `${Math.floor(at) % 12 || 12}:${String(Math.round((at % 1) * 60)).padStart(2, "0")} PT${/cto/i.test(change + own) ? " + CTO" : ""}` }, change || "All commitments confirmed."), change ? `Proposing a change: ${change.slice(0, 90)}` : "Confirmed every commitment");
    });
    status("handed off", change ? "proposed a change" : "all confirmed");
    await sent(ctx, `@Chief ${company}'s side confirms ${res.confirmed?.length ?? 0} of ${commitments.length} commitments.${change ? ` One change: ${change}` : ""}`,
      ["Chief"], { counterparty: true, change }, change ? "" : "pass");
    status("idle");
  };

  // Chief: the critic. Nothing is final until Chief passes it; a BLOCK is terminal until Echo resolves it.
  const rooms = new Map<string, { draft?: any; recruit?: string; counterparty?: string; passed?: any; change?: string }>();
  const passToDesk = async (ctx: RoomCtx, st: { recruit?: string; passed?: any; change?: string }, d: any) => {
    status("passed", `v${d.version}`);
    eye.mark("clear");
    await sent(ctx, `@Desk PASS on v${d.version}: every claim traced to a finding or the conversation, and ${d.company}'s agent ${st.change ? "set the plan" : "confirmed the commitments"}. Ready for George's yes.`, ["Desk"],
      { pass: true, version: d.version, draft: d.draft, sources: d.sources, checks: st.passed.checks, company: d.company, to: d.to, who: d.who, checker: `${st.recruit} and ${d.company}'s agent`, change: st.change, model: MODEL },
      "pass", { verdict: "PASS", version: d.version });
    status("idle");
  };
  return async (m, ctx) => {
    const st0 = rooms.get(m.roomId);
    if (m.from === "Counterparty" && m.payload?.counterparty && st0?.draft && st0.passed) {
      const d = st0.draft;
      if (m.payload.change && !st0.counterparty?.startsWith("updated")) {
        // the other side moved the plan: Echo updates the email to THEIR answer; that answer is the evidence
        st0.counterparty = "updating"; st0.change = m.payload.change;
        status("waiting", "Echo is updating to the other side's answer");
        await sent(ctx, `@Echo ${d.company}'s agent changed the plan: ${m.payload.change} Update the email to match, then send it back.`, ["Echo"], { update: m.payload.change });
        return;
      }
      return passToDesk(ctx, st0, d);
    }
    if (m.from === "Echo" && m.payload?.updated && st0?.counterparty === "updating") {
      st0.counterparty = "updated"; st0.draft = m.payload;
      const bad = lint(m.payload.draft);
      if (bad.length) {   // only the hard checks: the content change came from the other side itself
        await sent(ctx, `@Echo BLOCKED v${m.payload.version}:\n${bad.map(b => `✗ "${b.claim}": ${b.note}`).join("\n")}`, ["Echo"], { veto: true, update: st0.change, version: m.payload.version, issues: bad }, "veto", { verdict: "VETO", version: m.payload.version, issues: bad });
        st0.counterparty = "updating";
        return;
      }
      return passToDesk(ctx, st0, m.payload);
    }
    const st = rooms.get(m.roomId) ?? {};
    rooms.set(m.roomId, st);
    if (m.from === "Echo" && m.payload?.draft) {
      st.draft = m.payload;
      status("working", `reviewing v${m.payload.version}`);
      if (!st.recruit) {
        // who to bring in is decided now, from what this conversation was about and who is reachable
        const peers = await ctx.lookupPeers();
        report("recruit", { roomId: m.roomId, peers });
        const flags = (m.payload.scribe as Scribe | undefined)?.flags ?? {};
        const wanted = Object.entries(SPECIALISTS).filter(([, s]) => s.when && flags[s.when]).map(([n]) => n);
        const pool = (process.env.RECRUITABLE ?? "").split(",").filter(Boolean);   // who is actually online
        const ok = (n: string) => peers.includes(n) && (!pool.length || pool.includes(n));
        const who = wanted.find(ok) ?? ["PartnerCheck", "FactCheck"].find(ok) ?? "FactCheck";
        const why = wanted.includes(who) ? `the conversation was about ${SPECIALISTS[who]!.focus}` : who === "PartnerCheck"
          ? "the claims need an independent check from outside our org (a contact on another Band account)" : "the claims need verifying against Scout's sources";
        await ev(ctx, "thought", `Recruiting ${who}: ${why}.`);
        await ctx.addParticipant(who);
        st.recruit = who;
        report("sent", { roomId: m.roomId, text: `Chief recruited ${who} into the room (lookupPeers → addParticipant): ${why}`, mentions: [], tone: "recruit", who });
      }
      await sent(ctx, `@${st.recruit} verify every claim in Echo's draft v${m.payload.version} against the findings and the conversation.`, [st.recruit!],
        { draft: m.payload.draft, sources: m.payload.sources, version: m.payload.version });
      status("waiting", `on ${st.recruit}`);
      return;
    }
    if (m.from === st.recruit && m.payload?.checks && st.draft) {
      const d = st.draft;
      const checks = m.payload.checks as Check[];
      if (!checks?.length) return;   // no evidence is never a pass
      const review = await llm(`verdict v${d.version}`, think([
        { role: "system", content: "You are Chief, the critic. If a claim is not supported by a finding or transcript line posted in this room, the verdict is BLOCKED and you name the missing evidence. Otherwise PASS if the email makes a clear, honest next step. Reply with JSON only: {\"verdict\": \"PASS\"|\"BLOCKED\", \"reason\": \"one sentence\"}" },
        { role: "user", content: `Draft v${d.version}:\n${d.draft.body}\n\n${st.recruit} results:\n${checks.map(c => `${c.supported ? "✓" : "✗"} ${c.claim}${c.note ? ` (${c.note})` : ""}`).join("\n")}` },
      ], { maxTokens: 400, mock: () => JSON.stringify(checks.some(c => !c.supported) ? { verdict: "BLOCKED", reason: "a customer-count claim has no finding behind it" } : { verdict: "PASS", reason: "every claim traces to a finding and the next step is clear" }) }));
      const v = json<{ verdict: string; reason: string }>(review) ?? { verdict: "PASS", reason: "" };
      const blocked = /block|veto/i.test(v.verdict);
      // the hard rule wins over the model: any unsupported claim or placeholder blocks, whatever Chief's model says
      const bad: Check[] = [...checks.filter(c => !c.supported), ...lint(d.draft)];
      // Chief's own judgement can add a block on the first draft; after a fix, the evidence decides
      if (!bad.length && blocked && d.version === 1) bad.push({ claim: v.reason || "Chief's review", supported: false, note: "Chief's own review" });
      await ev(ctx, "thought", d.version > 1 && !bad.length && blocked ? `Chief (advisory, evidence is clean): ${v.reason}` : `Chief: ${v.verdict} · ${v.reason}`);
      await ws.write(`verdict-v${d.version}.json`, JSON.stringify({ version: d.version, unsupported: bad }, null, 1));
      if (bad.length && d.version >= MAX_VERSIONS) {
        status("blocked", `v${d.version} still blocked`);
        await sent(ctx, `@Desk BLOCKED: v${d.version} still has ${bad.length} unsupported claim(s). Nothing ships.`, ["Desk"],
          { pass: false, version: d.version, issues: bad }, "veto", { verdict: "VETO", version: d.version, issues: bad });
        return;
      }
      if (bad.length) {
        status("vetoed", `v${d.version}: ${bad.length} blocked`);
        eye.mark("block", bad.map(b => b.claim).join("; ").slice(0, 200));
        eye.run(async () => {
          const lines = (d.sources as Source[]).filter(x => x.id >= 100).map(x => ({ id: x.id, t: x.title.replace(/^Conversation\s+/, "").split(" · ")[0] ?? "", speaker: x.title.split(" · ")[1] ?? "", text: x.text }));
          await eye.view("blocked", views.blocked(bad, d.version), `BLOCKED v${d.version}: ${bad.length} claim(s) with no evidence`);
          if (lines.length) { await Bun.sleep(1800); await eye.view("transcript", views.transcript(lines, [], "What was actually said"), "Checking the conversation: nobody said it"); }
        });
        await sent(ctx, `@Echo BLOCKED v${d.version}. Missing evidence:\n${bad.map(b => `✗ "${b.claim}": ${b.note ?? "no finding or transcript line says this"}`).join("\n")}\nNothing ships until this is fixed. Send v${d.version + 1}.`,
          ["Echo"], { veto: true, version: d.version, issues: bad }, "veto", { verdict: "VETO", version: d.version, issues: bad });
        return;
      }
      const cps = ((d.scribe as Scribe | undefined)?.commitments ?? []);
      const pool = (process.env.RECRUITABLE ?? "").split(",");
      if (cps.length && pool.includes("Counterparty") && !st.counterparty) {
        // the boundary: the other company's agent (another Band account, a contact) sees ONLY the commitments
        st.counterparty = "asked"; st.passed = { version: d.version, checks };
        await ctx.removeParticipant(st.recruit!);
        report("sent", { roomId: m.roomId, text: `Chief dismissed ${st.recruit}: its check is done.`, mentions: [], tone: "dismiss", who: st.recruit });
        await ctx.addParticipant("Counterparty");
        report("sent", { roomId: m.roomId, text: "Chief brought in the other company's agent (a contact on another Band account). It sees only the commitments.", mentions: [], tone: "recruit", who: "Counterparty" });
        const lines = new Map((d.sources as Source[]).filter(x => x.id >= 100).map(x => [x.id, x.text]));
        await sent(ctx, `@Counterparty please confirm or correct what we agreed:\n${cps.map((c, i) => `${i + 1}. ${c.owner}: ${c.text}${c.due ? ` (${c.due})` : ""}`).join("\n")}`, ["Counterparty"],
          { company: d.company, commitments: cps.map(c => ({ ...c, said: c.line ? lines.get(c.line) : undefined })) });
        status("waiting", "on the other company's agent");
        return;
      }
      status("passed", `v${d.version}`);
      eye.mark("clear");
      await sent(ctx, `@Desk PASS on v${d.version}: every claim traced to a finding or the conversation. Ready for George's yes.`, ["Desk"],
        { pass: true, version: d.version, draft: d.draft, sources: d.sources, checks: m.payload.checks, company: d.company, to: d.to, who: d.who, checker: st.recruit, model: MODEL },
        "pass", { verdict: "PASS", version: d.version });
      status("idle");
    }
  };
}
