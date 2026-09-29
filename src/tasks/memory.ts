// Memory Synth: "What did I promise today?" from the deal graph (Neo4j), real conversations only: runs started from
// George's own texts or recordings. Rehearsals never count. Renders a promises page in its own browser, then leaves proof:
// counts, the promises (marked private: they're George's conversations), and for each one the second it was said.
// If the graph doesn't answer, the task fails and says so. It never reports "no promises" for a graph that's down.
import { latestRuns, promisesToday, startOfTodayPT, type PersonPromises, type PromiseItem } from "../graph/neo4j";
import type { Executor } from "./types";

const DAY = 86_400_000;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const hm = (t: number) => new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
const who = (p: PromiseItem) => (p.direction === "you" ? "You promised" : p.direction === "them" ? "They promised" : "You both agreed");
// the source second, never the words: "George at 0:25 · run 5ebcd742"
const second = (p: PromiseItem) => `${p.said ? `${p.said.speaker}${p.said.t ? ` at ${p.said.t}` : ""}` : "no line recorded"} · run ${p.runId}`;
const count = (gs: PersonPromises[]) => gs.reduce((a, g) => a + g.promises.length, 0);

function page(asOf: Date, realToday: number, today: PersonPromises[], week: PersonPromises[]) {
  const item = (p: PromiseItem) => `<li class="${p.status}"><div class="w"><span class="d">${esc(who(p))}</span> ${esc(p.what)}</div>
    <div class="m">${p.due ? `<b>due ${esc(p.due)}</b> · ` : ""}${p.status === "kept" ? "kept" : "open"}${p.followUpSent ? " · follow-up sent" : ""} · ${p.said ? "said by " : ""}${esc(second(p))}</div></li>`;
  const group = (g: PersonPromises) => `<div class="card"><h2>${esc(g.person)}${g.company ? ` <span>· ${esc(g.company)}</span>` : ""}</h2><ul>${g.promises.map(item).join("")}</ul></div>`;
  const body = !realToday
    ? `<div class="empty"><div class="big">No real conversations logged yet today.</div><div>Text Chief a note after each one, and the promises show up here.</div></div>`
    : !count(today)
      ? `<div class="empty"><div class="big">${realToday} real conversation${realToday === 1 ? "" : "s"} today, no promises in ${realToday === 1 ? "it" : "them"}.</div></div>`
      : today.map(group).join("");
  const later = week.filter(g => g.promises.length);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#000;color:#f4f2ee;font:17px/1.4 -apple-system,Inter,Helvetica,sans-serif;padding:18px 26px}
h1{font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:#ecd3a0;margin:0 0 2px;font-weight:600}.asof{color:#8e8e93;font-size:13px;margin-bottom:12px}
h3{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#ecd3a0;margin:16px 0 8px;font-weight:600}
.card{border:1px solid #2c2c2e;border-radius:12px;padding:10px 16px;background:#0b0b0b;margin-bottom:10px}
h2{font-size:18px;margin:0 0 6px}h2 span{color:#8e8e93;font-weight:400}
ul{list-style:none;margin:0;padding:0}li{padding:7px 0;border-top:1px solid #1c1c1e}li:first-child{border-top:0}
.w{font-size:17px}.d{color:#ecd3a0;font-weight:600}.m{color:#8e8e93;font-size:13px;margin-top:2px}.m b{color:#f4f2ee;font-weight:600}
li.kept .w{color:#8e8e93}li.kept .d{color:#8e8e93}
.empty{border:1px dashed #3a3a3c;border-radius:12px;padding:26px;text-align:center;color:#8e8e93}.empty .big{color:#f4f2ee;font-size:20px;margin-bottom:6px}
</style></head><body>
<h1>Memory Synth · what you promised</h1>
<div class="asof">Today (Pacific), as of ${esc(hm(asOf.getTime()))} · from the deal graph · real conversations only, rehearsals never count</div>
${body}
${later.length ? `<h3>Still open from this week</h3>${later.map(group).join("")}` : ""}
</body></html>`;
}

const memory: Executor = {
  synth: "memory", name: "Memory Synth", title: "Chief of staff", kind: "promises", sponsors: ["Neo4j"],
  propose() {
    return { task: "What did I promise today? Log it and show what's due this week", why: "So nothing you promised in a real conversation slips: each promise with the second it was said." };
  },
  async run(ctx) {
    const asOf = new Date(), today0 = startOfTodayPT(asOf);
    ctx.log("Reading today's real conversations from the deal graph");
    let real: Awaited<ReturnType<typeof latestRuns>>, today: PersonPromises[], week: PersonPromises[];
    try {
      real = (await latestRuns(50, { rehearsals: false })).filter(r => r.at >= today0 && !r.id.startsWith("test-"));
      today = await promisesToday({ since: today0 });
      week = await promisesToday({ since: asOf.getTime() - 7 * DAY });
    } catch (e) {
      throw new Error(`the deal graph (Neo4j) didn't answer, so there is nothing honest to show: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    // this week = promises from the last 7 days that are still open and weren't made today
    const todayIds = new Set(today.flatMap(g => g.promises.map(p => p.id)));
    const earlier = week.map(g => ({ ...g, promises: g.promises.filter(p => p.status === "open" && !todayIds.has(p.id) && p.at < today0) })).filter(g => g.promises.length);
    const n = count(today), open = today.reduce((a, g) => a + g.promises.filter(p => p.status === "open").length, 0);

    ctx.log(real.length ? `${real.length} real conversation${real.length === 1 ? "" : "s"} today, ${n} promise${n === 1 ? "" : "s"} (${open} open)` : "No real conversations logged yet today");
    for (const g of today) ctx.log(`${g.person}: ${g.promises.length} promise${g.promises.length === 1 ? "" : "s"}, ${g.promises.filter(p => p.status === "open").length} open`);   // counts only; the words stay on the page

    await ctx.page.view("memory", page(asOf, real.length, today, earlier), "Memory Synth · what you promised today");
    await ctx.shot("What you promised today, from the deal graph");

    const from = "Neo4j deal graph: Run nodes of kind real since 00:00 PT";
    ctx.proof("number", { label: "Real conversations today", value: real.length, from });
    ctx.proof("number", { label: "Promises today", value: n, from: "Commitments + George's grounded email promises in those runs" });
    ctx.proof("number", { label: "Still open today", value: open, from: "promise status in the graph (kept only when marked kept)" });
    if (earlier.length) ctx.proof("number", { label: "Still open from this week", value: count(earlier), from: "open promises from the last 7 days, before today" });
    for (const r of real) ctx.proof("id", { label: `Run · ${r.company ?? "conversation"}`, value: r.id });
    // the promises themselves are George's conversations: private on the public host
    ctx.proof("result", real.length
      ? { title: "What you promised today", private: true,
          rows: today.flatMap(g => g.promises.map(p => ({ who: `${g.person}${g.company ? ` · ${g.company}` : ""}`, promise: `${who(p)}: ${p.what}`, due: p.due ?? "", status: p.status + (p.followUpSent ? ", follow-up sent" : ""), "said at": second(p) }))) }
      : { title: "What you promised today", lines: ["No real conversations logged yet today. Text Chief a note after each one."] });
    if (earlier.length) ctx.proof("result", { title: "Still open from this week", private: true,
      rows: earlier.flatMap(g => g.promises.map(p => ({ who: g.person, promise: `${who(p)}: ${p.what}`, due: p.due ?? "", "said at": second(p) }))) });

    return real.length ? `${n} promise${n === 1 ? "" : "s"} today from ${real.length} real conversation${real.length === 1 ? "" : "s"}, ${open} open${earlier.length ? `; ${count(earlier)} still open from this week` : ""}.` : "No real conversations logged yet today.";
  },
};
export default memory;
