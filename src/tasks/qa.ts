// QA Synth: checks trusynth.com at phone size and reports broken links.
// Read-only: it opens pages and reads their links; it never fills a form, signs in or starts a download.
// Crawls the same host only (max 25 pages, about one request a second to trusynth.com, robots.txt respected), checks
// every unique link's HTTP status (external links: HEAD only, 8 s timeout) and screenshots each page it opens.
// It only reports what it saw: nothing is ever marked fixed.
import type { Executor, TaskCtx } from "./types";
import { host } from "./web";

const START = "https://trusynth.com/";
const SITE = "trusynth.com";
const MAX_PAGES = 25, MAX_EXTERNAL = 60, BUDGET_MS = 170_000, TIMEOUT_MS = 8000;
const W = 390, H = 844;
// visited only by status check, never opened in the browser: sign-in, account, checkout and download pages, APIs
const NO_VISIT = /\/(login|log-in|signin|sign-in|signup|sign-up|logout|signout|auth|account|checkout|download|api|cdn-cgi)(\/|\?|$)/i;
const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|dmg|pkg|mp4|mov|webm|mp3|css|js|json|xml|txt)(\?|$)/i;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 TRU-Synth-QA";
// statuses that usually mean "this site blocks automated checks", not "this link is broken"
const UNVERIFIABLE = new Set([401, 403, 405, 429, 999]);

type Check = { url: string; status: number; note: string };


const norm = (href: string) => {
  try { const u = new URL(href); if (!/^https?:$/.test(u.protocol)) return null; u.hash = ""; return u.toString(); } catch { return null; }
};
const pathOf = (u: string) => { try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch { return u; } };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function check(url: string, internal: boolean): Promise<Check> {
  const go = (method: string) => fetch(url, { method, redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  try {
    let r = await go("HEAD");
    // our own site gets one GET when HEAD isn't supported; external links stay HEAD-only
    if (internal && (r.status === 405 || r.status === 501)) { await r.body?.cancel(); r = await go("GET"); }
    await r.body?.cancel();
    return { url, status: r.status, note: r.redirected ? `redirects to ${pathOf(r.url)}` : "" };
  } catch (e) {
    const s = String(e);
    return { url, status: 0, note: /timed? ?out|TimeoutError/i.test(s) ? `no answer in ${TIMEOUT_MS / 1000} s` : "could not connect" };
  }
}

async function robots(): Promise<string[]> {
  try {
    const r = await fetch(`${START}robots.txt`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return [];
    let any = false; const out: string[] = [];
    for (const line of (await r.text()).split("\n")) {
      const [k, ...v] = line.split(":"); const key = k?.trim().toLowerCase(), val = v.join(":").trim();
      if (key === "user-agent") any = val === "*";
      else if (any && key === "disallow" && val) out.push(val);
    }
    return out;
  } catch { return []; }
}

const phone = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;background:#0b0b0c;color:#ecebe8;font:15px/1.4 -apple-system,Inter,Helvetica,sans-serif;padding:18px 16px}
h1{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#d8c08a;margin:0 0 10px;font-weight:600}
.big{font-size:26px;margin:0 0 12px}.m{color:#8c8a84;font-size:13px}.row{padding:8px 0;border-bottom:1px solid #1d1c1b;word-break:break-all}
.s{display:inline-block;min-width:40px;color:#e5484d;font-variant-numeric:tabular-nums}.ok{color:#d8c08a}.w{color:#c9a86a}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

const qa: Executor = {
  synth: "qa", name: "QA Synth", title: "QA lead", kind: "qa", sponsors: ["Crusoe"],
  propose() {
    return { task: "Check trusynth.com at phone size and report broken links", why: "Most people meet us on a phone; a dead link there is the first thing they see." };
  },
  async run(ctx) {
    const t0 = Date.now(), left = () => BUDGET_MS - (Date.now() - t0);
    const page = ctx.page;
    await page.viewport(W, H, true);
    try {
      const disallow = await robots();
      const allowed = (u: string) => !disallow.some(d => pathOf(u).startsWith(d));

      // 1. crawl: open each same-host page in the browser, read its links, screenshot it
      const queue = [START], queued = new Set([START]);
      const from = new Map<string, Set<string>>();   // link → the pages it appears on
      const pages: string[] = [], layout: { page: string; width: number; viewport: number }[] = [], noLoad: string[] = [];
      const seenStatus = new Map<string, Check>();
      let measured = 0, skippedPages = 0;
      while (queue.length) {
        if (pages.length >= MAX_PAGES || left() < 60_000 || ctx.signal.aborted) { skippedPages = queue.length; break; }
        const url = queue.shift()!, p = pathOf(url);
        ctx.log(`Opening ${p} at phone size (${pages.length + 1}/${Math.min(MAX_PAGES, pages.length + 1 + queue.length)})`);
        const ok = await page.goto(url, `QA · ${p}`);
        pages.push(url);
        if (!ok) { noLoad.push(url); continue; }
        const info = await page.evaluate<{ hrefs: string[]; sw: number; vw: number; status: number }>(
          `() => ({ hrefs: [...document.querySelectorAll("a[href]")].map(a => a.href), sw: document.documentElement.scrollWidth, vw: window.innerWidth, status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0 })`);
        // the page's own HTTP status, from the browser's navigation entry: no second request for pages we opened
        if (info?.status) seenStatus.set(url, { url, status: info.status, note: "" });
        measured = info?.vw ?? measured;
        if (info && info.vw <= 430 && info.sw > info.vw + 1) layout.push({ page: url, width: info.sw, viewport: info.vw });
        for (const h of info?.hrefs ?? []) {
          const u = norm(h); if (!u) continue;
          (from.get(u) ?? from.set(u, new Set()).get(u)!).add(url);
          if (host(u) === SITE && new URL(u).hostname === SITE && !ASSET.test(u) && !NO_VISIT.test(new URL(u).pathname) && allowed(u) && !queued.has(u)) { queued.add(u); queue.push(u); }
        }
        await ctx.shot(`${p} at ${info?.vw ?? "?"} px wide`);
        await Bun.sleep(400);   // with goto's own settle time this keeps the crawl near one page a second
      }

      // 2. status of every unique link: our site one request a second, external sites HEAD-only, 4 at a time
      const cfEmail = [...from.keys()].filter(u => /\/cdn-cgi\/l\/email-protection/.test(u));
      const all = [...from.keys()].filter(u => !cfEmail.includes(u));
      const internal = all.filter(u => new URL(u).hostname === SITE && !seenStatus.has(u));
      const external = all.filter(u => new URL(u).hostname !== SITE);
      const extChecked = external.slice(0, MAX_EXTERNAL);
      ctx.log(`${seenStatus.size} pages' status came from the browser; checking ${internal.length} more links on ${SITE} and ${extChecked.length} external links`);
      const results: Check[] = [...seenStatus.values()].filter(r => from.has(r.url) || r.url === START);
      const show = () => page.view("qa", phone("QA Synth · checking links", `<div class="big">${results.length} / ${internal.length + extChecked.length}</div>
${results.filter(r => r.status === 0 || r.status >= 400).slice(-8).map(r => `<div class="row"><span class="s">${r.status || "—"}</span> ${esc(r.url)}</div>`).join("") || `<div class="m">No problems so far.</div>`}`), "QA Synth · checking links");
      let lastShow = 0, showing: Promise<void> | null = null;
      const tick = async () => { if (!showing && Date.now() - lastShow > 2500) { lastShow = Date.now(); showing = show().catch(() => {}).finally(() => { showing = null; }); } };
      const own = (async () => {
        for (const u of internal) {
          if (left() < 8000 || ctx.signal.aborted) break;
          const t = Date.now();
          results.push(await check(u, true)); await tick();
          await Bun.sleep(Math.max(0, 1000 - (Date.now() - t)));   // about one request a second to our own site
        }
      })();
      const ext = (async () => {
        const q = [...extChecked];
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (q.length && left() > TIMEOUT_MS + 2000 && !ctx.signal.aborted) { results.push(await check(q.shift()!, false)); await tick(); }
        }));
      })();
      await Promise.all([own, ext]);
      await showing;
      const unchecked = all.filter(u => !results.some(r => r.url === u));

      // 3. sort: broken vs could-not-verify
      const isInternal = (u: string) => new URL(u).hostname === SITE;
      const problems = results.filter(r => r.status === 0 || (r.status >= 400 && !(UNVERIFIABLE.has(r.status) && !isInternal(r.url))));
      const blocked = results.filter(r => UNVERIFIABLE.has(r.status) && !isInternal(r.url));
      for (const u of noLoad) if (!problems.some(r => r.url === u)) problems.push({ url: u, status: 0, note: "did not load in the browser in 15 s" });
      const on = (u: string) => [...(from.get(u) ?? [])].map(pathOf).slice(0, 3).join(", ") || "start page";

      // 4. show up to 3 broken links where they sit on the page
      for (const pr of problems.slice(0, 3)) {
        const src = [...(from.get(pr.url) ?? [])][0];
        if (!src || left() < 12_000) break;
        if (await page.goto(src, `QA · broken link on ${pathOf(src)}`)) {
          // outline a copy of the link that is visible at phone size; one only inside a closed menu is said as such
          const found = await page.evaluate<"visible" | "hidden" | "">(String((href: string) => {
            const all = Array.from(document.querySelectorAll("a[href]")).filter(x => (x as HTMLAnchorElement).href.split("#")[0] === href) as HTMLElement[];
            const a = all.find(x => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(x).visibility !== "hidden"; });
            if (!a) return all.length ? "hidden" : "";
            a.scrollIntoView({ block: "center" }); a.style.outline = "3px solid #e5484d"; a.style.outlineOffset = "3px";
            return "visible";
          }), pr.url);
          await Bun.sleep(600);
          await ctx.shot(`${pr.status || "no answer"}: ${pathOf(pr.url)} ${found === "visible" ? "outlined" : found === "hidden" ? "is in a closed menu" : "is linked"} on ${pathOf(src)}`);
        }
      }

      // 5. report
      ctx.log(`Writing the report: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
      const n = pages.length, m = results.length, k = problems.length;
      const summary = `${n} pages, ${m} links, ${k} problem${k === 1 ? "" : "s"}`;
      const notes = [
        ...(layout.length ? [`Wider than the phone screen: ${layout.map(l => `${pathOf(l.page)} (${l.width} px)`).join(", ")}`] : []),
        ...(blocked.length ? [`${blocked.length} external links refused automated checks, so they are not verified: ${blocked.slice(0, 5).map(b => `${b.status} ${host(b.url)}`).join(", ")}`] : []),
        ...(measured && measured > 430 ? [`The browser ran at ${measured} px, not phone width`] : []),
        ...(skippedPages ? [`Stopped at ${n} pages (cap ${MAX_PAGES} or the 3-minute budget); ${skippedPages} more pages found but not opened`] : []),
        ...(unchecked.length ? [`${unchecked.length} links not checked (time budget or the ${MAX_EXTERNAL}-external cap)`] : []),
        ...(cfEmail.length ? [`${cfEmail.length} Cloudflare-protected email link${cfEmail.length === 1 ? "" : "s"} not checked (the browser turns them into mailto: links)`] : []),
        ...(disallow.length ? [`robots.txt respected (${disallow.length} rules)`] : []),
      ];
      await page.view("qa-report", phone("QA Synth · trusynth.com", `<div class="big">${esc(summary)}</div>
<div class="m">Checked at ${measured || "?"} px wide · ${new Date().toISOString().slice(11, 16)}Z</div>
${k ? problems.map(p => `<div class="row"><span class="s">${p.status || "—"}</span> ${esc(p.url)}<br><span class="m">${esc(p.note || "")} on ${esc(on(p.url))}</span></div>`).join("") : `<div class="row ok">No broken links found.</div>`}
${notes.map(x => `<div class="row m">${esc(x)}</div>`).join("")}`), "QA Synth · report");
      await ctx.shot(summary);

      ctx.proof("number", { label: "Pages checked", value: n, from: `opened in the QA Synth's browser at ${measured || "?"} px wide` });
      ctx.proof("number", { label: "Links checked", value: m, from: `HTTP status per unique link; external links HEAD only, ${TIMEOUT_MS / 1000} s timeout` });
      ctx.proof("number", { label: "Problems", value: k, from: "status 0 (no answer), 4xx or 5xx; for external links 401/403/405/429/999 are listed as unverifiable instead" });
      ctx.proof("result", {
        title: summary,
        lines: [
          ...(k ? problems.map(p => `${p.status || "no answer"} ${p.url}${p.note ? ` (${p.note})` : ""}, on ${on(p.url)}`) : ["No broken links found."]),
          ...notes,
        ],
        rows: problems.map(p => ({ status: p.status || "no answer", link: p.url, note: p.note, on: on(p.url) })),
      });
      return `${summary}${k ? `: ${problems.slice(0, 3).map(p => `${p.status || "no answer"} ${pathOf(p.url)}`).join(", ")}` : ""}.`;
    } finally {
      await page.viewport(960, 600, false);
    }
  },
};
export default qa;
