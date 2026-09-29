// Finance Synth: tonight's burn, from real account calls only.
//   Vultr       /v2/account (balance, pending charges) + /v2/billing/pending-charges (line items) + running event VMs × /v2/plans price
//   OpenRouter  /api/v1/key (today's spend). The $10 promo grant isn't exposed by the API (/credits says $0), so the credit is
//               a hand reading from the dashboard, shown as exactly that with its time. The key's limit is a spending cap, not credit.
//   Crusoe      no billing API we can read: the router meter's lines in tonight's runs (runs/*.json) × list prices
//               (public/panel-crusoe.js); only total tokens are logged per call, so $ is an upper bound (≤)
// Rendered as one page in the Synth's own browser. A call that fails shows as failed, never as a guess. Keys never appear.
import { readdir } from "node:fs/promises";
import type { Executor, TaskCtx } from "./types";

type Got<T> = { ok: true; v: T } | { ok: false; error: string };
const DEADLINE = "2026-09-30T03:00:00Z";
// read by hand on the OpenRouter dashboard (the API doesn't expose promo grants); update this line if it changes
const OPENROUTER_GRANT = { usd: 10, read: "12:01 PM PT", where: "the OpenRouter dashboard" };

function scrub(ctx: TaskCtx, s: string) {
  for (const k of Object.values(ctx.keys)) if (k && k.length > 8) s = s.split(k).join("[key]");
  return s.slice(0, 160);
}
async function get<T>(ctx: TaskCtx, url: string, key: string | undefined): Promise<Got<T>> {
  if (!key) return { ok: false, error: "no key in the Keychain" };
  try {
    let r = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    // one retry on a 5xx or 429 (Vultr answers 502 during its upgrades)
    if (r.status >= 500 || r.status === 429) { await Bun.sleep(2500); r = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }); }
    if (!r.ok) return { ok: false, error: scrub(ctx, `${r.status} ${(await r.text()).slice(0, 120)}`) };
    return { ok: true, v: await r.json() as T };
  } catch (e) { return { ok: false, error: scrub(ctx, String(e)) }; }
}

const usd = (x: number) => x === 0 ? "$0.00" : Math.abs(x) < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function crusoeRates(): Promise<Record<string, [number, number]>> {
  // one source of truth: the Crusoe panel's list prices
  const src = await Bun.file("public/panel-crusoe.js").text().catch(() => "");
  const out: Record<string, [number, number]> = {};
  for (const m of src.matchAll(/"([\w.\/-]+)":\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)) out[m[1]!.toLowerCase()] = [Number(m[2]), Number(m[3])];
  return out;
}

async function crusoeMeter(since: number) {
  const rates = await crusoeRates();
  const files = (await readdir("runs").catch(() => [] as string[])).filter(f => /^[0-9a-f]{8}\.json$/.test(f));
  let runs = 0, calls = 0, tokens = 0, usdMax = 0, unpriced = 0;
  const byModel = new Map<string, { calls: number; tokens: number; usd: number | null }>();
  for (const f of files) {
    const r = await Bun.file(`runs/${f}`).json().catch(() => null) as any;
    if (!r?.started || r.started < since || !Array.isArray(r.lines)) continue;
    let used = false;
    for (const l of r.lines) {
      const m = l?.kind === "llm" && /^thought on Crusoe · (.+?) · (\d+) ms · (\d+) tok/.exec(l.text ?? "");
      if (!m) continue;
      used = true; calls++;
      const model = m[1]!, tok = Number(m[3]), rate = rates[model.toLowerCase()];
      tokens += tok;
      const c = rate ? tok * rate[1] / 1e6 : null;
      if (c == null) unpriced++; else usdMax += c;
      const b = byModel.get(model) ?? { calls: 0, tokens: 0, usd: 0 };
      b.calls++; b.tokens += tok; b.usd = c == null || b.usd == null ? null : b.usd + c;
      byModel.set(model, b);
    }
    if (used) runs++;
  }
  return { runs, calls, tokens, usdMax, unpriced, byModel: [...byModel].map(([model, b]) => ({ model, ...b })) };
}

function page(asOf: Date, v: any, o: any, c: any) {
  const pt = new Date(asOf.getTime() - 7 * 3.6e6);
  const hh = (d: Date) => `${d.getUTCHours() % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;
  const fail = (e: string) => `<div class="bad">Call failed: ${esc(e)}</div>`;
  const big = (label: string, value: string, note = "") => `<div class="big"><div class="l">${esc(label)}</div><div class="n">${esc(value)}</div>${note ? `<div class="m">${esc(note)}</div>` : ""}</div>`;
  const vultr = !v.account.ok ? fail(v.account.error) : `
    <div class="row3">${big("Credit left", usd(v.creditLeft), "after pending charges")}${big("Pending charges", usd(v.account.v.account.pending_charges), "this billing period")}${big("Burning now", `${usd(v.perHour)}/h`, `${v.running} event VM${v.running === 1 ? "" : "s"} running`)}</div>
    ${v.items.length ? `<div class="chips">${v.items.slice(0, 4).map((i: any) => `<span>${esc(i.what)} · ${i.hours} h · ${usd(i.total)}</span>`).join("")}${v.items.length > 4 ? `<span>+${v.items.length - 4} more</span>` : ""}</div>` : ""}
    <div class="m">If nothing else starts: ${usd(v.toTeardown)} more until the 03:00Z teardown.</div>`;
  const or = !o.key.ok ? fail(o.key.error) : `
    <div class="row3">${big("Spent today", usd(o.key.v.data.usage_daily ?? 0), "from /key")}${big("Credit · promo grant", usd(OPENROUTER_GRANT.usd), `read by hand, dashboard ${OPENROUTER_GRANT.read}`)}${big("Key cap", o.key.v.data.limit == null ? "none" : usd(o.key.v.data.limit), "a spending cap, not credit")}</div>`;
  const cr = `
    <div class="row3">${big("Credits left", "not readable", "no billing API we can call")}${big("Spent tonight", c.calls ? `≤ ${usd(c.usdMax)}` : "$0.00", `${c.calls} calls in ${c.runs} Deal Room run${c.runs === 1 ? "" : "s"}${c.unpriced ? `, ${c.unpriced} with no list price` : ""}`)}${big("Tokens", c.tokens.toLocaleString("en-US"), "router meter")}</div>
    ${c.byModel.length ? `<table>${c.byModel.map((b: any) => `<tr><td>${esc(b.model)}</td><td class="r">${b.calls} calls</td><td class="r">${b.tokens.toLocaleString("en-US")} tok</td><td class="r">${b.usd == null ? "no list price" : "≤ " + usd(b.usd)}</td></tr>`).join("")}</table>` : ""}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#0b0b0c;color:#ecebe8;font:18px/1.35 -apple-system,Inter,Helvetica,sans-serif;padding:18px 26px}
h1{font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#d8c08a;margin:0 0 4px;font-weight:600}.asof{color:#8c8a84;font-size:14px;margin-bottom:10px}
h2{font-size:16px;margin:0 0 6px;font-weight:600}h2 span{color:#8c8a84;font-weight:400;font-size:13px}
.card{border:1px solid #2a2927;border-radius:10px;padding:10px 16px;background:#121213;margin-bottom:8px}
.row3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.l{color:#8c8a84;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.n{font-size:26px;font-variant-numeric:tabular-nums;color:#ecebe8}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}.chips span{font-size:12px;color:#c9c7c1;border:1px solid #2a2927;border-radius:999px;padding:2px 9px}.m{color:#8c8a84;font-size:13px}
table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}td{padding:3px 0;border-top:1px solid #1d1c1b}.r{text-align:right;font-variant-numeric:tabular-nums;color:#c9c7c1}
.bad{color:#e5484d}</style></head><body>
<h1>Finance Synth · tonight's burn</h1><div class="asof">As of ${hh(pt)} PT (${asOf.toISOString().slice(11, 16)}Z) · every number from a live account call, except the one marked as read by hand</div>
<div class="card"><h2>Vultr <span>/v2/account · /v2/billing/pending-charges · /v2/plans</span></h2>${vultr}</div>
<div class="card"><h2>OpenRouter <span>/api/v1/key · the grant from the dashboard (the API doesn't expose grants)</span></h2>${or}</div>
<div class="card"><h2>Crusoe <span>router meter · list prices, ≤ because only total tokens are logged</span></h2>${cr}</div>
</body></html>`;
}

const finance: Executor = {
  synth: "finance", name: "Finance Synth", title: "Finance lead", kind: "burn", sponsors: ["Vultr", "OpenRouter", "Crusoe"],
  propose() {
    return { task: "Tonight's burn: credits left on Crusoe, Vultr, OpenRouter", why: "Know what the demo is costing before anyone asks, from the accounts themselves." };
  },
  async run(ctx) {
    const asOf = new Date();
    ctx.log("Reading the Vultr account");
    const V = "https://api.vultr.com/v2";
    const [account, pending, instances, plans] = await Promise.all([
      get<any>(ctx, `${V}/account`, ctx.keys.vultr),
      get<any>(ctx, `${V}/billing/pending-charges`, ctx.keys.vultr),
      get<any>(ctx, `${V}/instances?per_page=100`, ctx.keys.vultr),
      get<any>(ctx, `${V}/plans?type=vc2&per_page=500`, ctx.keys.vultr),
    ]);
    const price = new Map<string, number>(plans.ok ? plans.v.plans.map((p: any) => [p.id, p.hourly_cost]) : []);
    const running = instances.ok ? instances.v.instances.filter((i: any) => (i.tags ?? []).some((t: string) => t === "hackday-0929" || t === "synth-vm-workers")) : [];
    const perHour = running.reduce((a: number, i: any) => a + (price.get(i.plan) ?? 0), 0);
    const hoursLeft = Math.max(0, (Date.parse(DEADLINE) - asOf.getTime()) / 3.6e6);
    const v = {
      account, running: running.length, perHour, toTeardown: perHour * hoursLeft,
      // Vultr: a negative balance is credit
      creditLeft: account.ok ? -account.v.account.balance - account.v.account.pending_charges : 0,
      // line items without IPs (the page is on the public wall)
      items: pending.ok ? pending.v.pending_charges.map((p: any) => ({ what: /\[([^\]]+)\]/.exec(p.description)?.[1] ?? String(p.description).replace(/\d{1,3}(\.\d{1,3}){3}\s*/g, "").trim(), hours: p.units, total: p.total })) : [],
    };
    if (!account.ok) ctx.log(`Vultr account call failed: ${account.error}`);

    ctx.log("Reading OpenRouter spend");
    const OR = "https://openrouter.ai/api/v1";
    const key = await get<any>(ctx, `${OR}/key`, ctx.keys.openrouter);
    if (!key.ok) ctx.log(`OpenRouter key call failed: ${key.error}`);

    ctx.log("Adding up Crusoe calls from the router meter");
    const c = await crusoeMeter(asOf.getTime() - 24 * 3.6e6);

    ctx.log("Rendering the burn page");
    await ctx.page.view("finance", page(asOf, v, { key }, c), "Finance Synth · tonight's burn");
    await ctx.shot("Tonight's burn, from the account APIs");

    if (account.ok) {
      ctx.proof("number", { label: "Vultr credit left", value: +v.creditLeft.toFixed(2), unit: "$", from: "Vultr /v2/account (balance + pending_charges)" });
      ctx.proof("number", { label: "Vultr pending charges", value: account.v.account.pending_charges, unit: "$", from: "Vultr /v2/account" });
    }
    if (instances.ok && plans.ok) ctx.proof("number", { label: "Vultr burn now", value: +perHour.toFixed(3), unit: "$/h", from: `${running.length} event VMs (/v2/instances) × /v2/plans hourly price` });
    if (key.ok) {
      ctx.proof("number", { label: "OpenRouter spent today", value: +Number(key.v.data.usage_daily).toFixed(4), unit: "$", from: "OpenRouter /api/v1/key" });
    }
    ctx.proof("number", { label: "OpenRouter credit (promo grant)", value: OPENROUTER_GRANT.usd, unit: "$", from: `read by hand from ${OPENROUTER_GRANT.where} at ${OPENROUTER_GRANT.read}; the API doesn't expose grants` });
    ctx.proof("number", { label: "Crusoe calls tonight", value: c.calls, from: `router meter lines in ${c.runs} Deal Room runs (runs/*.json, last 24 h)` });
    if (c.calls) ctx.proof("number", { label: "Crusoe spend tonight (upper bound)", value: +c.usdMax.toFixed(4), unit: "$", from: `total tokens × list output price${c.unpriced ? `; ${c.unpriced} calls on a model with no list price not counted` : ""}` });

    const failed = [!account.ok && "Vultr account", !pending.ok && "Vultr pending charges", !key.ok && "OpenRouter key"].filter(Boolean) as string[];
    ctx.proof("result", {
      title: "Tonight's burn",
      lines: [
        account.ok ? `Vultr: ${usd(v.creditLeft)} credit left, ${usd(account.v.account.pending_charges)} pending, ${usd(perHour)}/h now (${running.length} VMs)` : `Vultr: account call failed (${account.error})`,
        key.ok ? `OpenRouter: ${usd(Number(key.v.data.usage_daily ?? 0))} spent today (from /key); credit ${usd(OPENROUTER_GRANT.usd)} promo grant, read from ${OPENROUTER_GRANT.where} at ${OPENROUTER_GRANT.read}` : `OpenRouter: key call failed (${key.error})`,
        `Crusoe: credits not readable (no billing API); ${c.calls} calls, ${c.tokens.toLocaleString("en-US")} tokens tonight${c.calls ? `, ≤ ${usd(c.usdMax)} at list price` : ""}`,
        ...(failed.length ? [`Failed calls: ${failed.join(", ")}`] : []),
      ],
    });
    if (!account.ok && !key.ok) throw new Error("both the Vultr and OpenRouter account calls failed, so there is no burn to report");
    return `Burn: Vultr ${account.ok ? `${usd(v.creditLeft)} credit left, ${usd(perHour)}/h` : "call failed"} · OpenRouter ${key.ok ? `${usd(Number(key.v.data.usage_daily ?? 0))} today` : "call failed"} · Crusoe ${c.calls} calls${c.calls ? ` ≤ ${usd(c.usdMax)}` : ""}.`;
  },
};
export default finance;
