/// <reference lib="dom" />
// Each worker's own headless browser, streamed live to the wall (CDP screencast → server /frame → SSE /frames).
// Read-only: it opens pages, scrolls and highlights. It never signs in, types into a site or submits a form.
// Locally every worker opens a tab in the server's one headless Chrome (CDP_URL); on a Vultr VM it launches its own.
// Off unless SYNTH_FRAMES=1. It never throws into the worker: a browser failure only costs the picture.
import type { Report } from "./roles";

const W = 960, H = 600;

export type Eye = {
  goto(url: string, caption: string): Promise<boolean>;
  view(name: string, html: string, caption: string): Promise<void>;
  highlight(text: string, tone?: "found" | "notfound"): Promise<boolean>;
  scroll(px?: number): Promise<void>;
  type(selector: string, text: string, cps?: number): Promise<void>;
  mark(kind: "block" | "found" | "notfound" | "clear", text?: string): void;
  shot(): Promise<string | null>;                 // base64 JPEG of the current page
  read(max?: number): Promise<{ title: string; text: string; url: string }>;
  evaluate<T = any>(fn: string, arg?: unknown): Promise<T | undefined>;   // read-only DOM queries
  where(): string;                                // the page's current url
  viewport(w: number, h: number, mobile?: boolean): Promise<void>;   // 960x600 restores the default
  close(): Promise<void>;                         // close the tab (one-off eyes)
  run(fn: () => Promise<void>): void;   // queue a show; the room flow never waits for it
};

// a tiny CDP client on Bun's own WebSocket (Playwright's connectOverCDP hangs under Bun)
type Cdp = { send(method: string, params?: any): Promise<any>; on(ev: string, fn: (p: any) => void): void };
function cdpClient(wsUrl: string): Promise<Cdp> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
    const subs = new Map<string, ((p: any) => void)[]>();
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id)!; waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
      else if (m.method) for (const fn of subs.get(m.method) ?? []) fn(m.params);
    };
    ws.onerror = () => fail(new Error("cdp socket error"));
    ws.onopen = () => ok({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (waiting.delete(i)) rej(new Error(`${method} timed out`)); }, 20000); }),
      on: (ev, fn) => subs.set(ev, [...(subs.get(ev) ?? []), fn]),
    });
  });
}

// the browser endpoint: the server's shared Chrome (CDP_URL), or on a VM our own Chromium (CHROME_PATH or Playwright's)
async function endpoint(cdp?: string): Promise<string> {
  if (cdp) return cdp;
  const port = 9300 + Math.floor(Math.random() * 400);
  let bin = process.env.CHROME_PATH;
  if (!bin) {
    const home = process.env.HOME ?? "/root";
    for (const pat of [`${home}/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`, `${home}/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux*/headless_shell`])
      for await (const f of new Bun.Glob(pat.replace(/^\//, "")).scan({ cwd: "/", absolute: true })) { bin = f; break; }
    bin ??= ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(b => Bun.file(b).size > 0);
  }
  if (!bin) throw new Error("no Chromium found");
  Bun.spawn([bin, "--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--no-sandbox", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--mute-audio", `--user-data-dir=/tmp/synth-chrome-${port}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false)) return `http://127.0.0.1:${port}`; await Bun.sleep(250); }
  throw new Error("Chromium did not start");
}

// a web search in the worker's own browser. Some IPs (e.g. cloud VMs) get Brave's bot check: then Bing, said honestly.
export async function webSearch(eye: Eye, q: string, caption: string) {
  if (await eye.goto(`https://search.brave.com/search?q=${encodeURIComponent(q)}`, caption)) {
    const txt = (await eye.read(600)).text;
    if (!/confirm you are human|security check|captcha/i.test(txt)) return "Brave";
  }
  await eye.goto(`https://www.bing.com/search?q=${encodeURIComponent(q)}`, `${caption} (Brave asked for a bot check; Bing)`.slice(0, 80));
  return "Bing";
}

export type EyeOpts = { server?: string; token?: string; cdp?: string; on?: boolean; headers?: Record<string, string> };
export function makeEye(role: string, report: Report, o: EyeOpts = {}): Eye {
  const server = o.server ?? process.env.SERVER_URL, token = o.token ?? process.env.TELEMETRY_TOKEN ?? "";
  const ON = o.on ?? process.env.SYNTH_FRAMES === "1", cdp = o.cdp ?? process.env.CDP_URL;
  // a worker on a VM sends its frames over the tunnel into George's Mac (data saver): fewer, smaller frames
  const remote = !!server && !/\/\/(localhost|127\.0\.0\.1)/.test(server);
  const GAP = remote ? 340 : 160, IDLE = remote ? 5000 : 1100, Q = remote ? 40 : 55;
  let page: Cdp | null = null, opening: Promise<Cdp | null> | null = null, caption = "", url = "", local = false, last = 0;
  let queue: Promise<void> = Promise.resolve();
  let still: Timer | null = null;

  const post = (path: string, body: unknown) => server ? fetch(`${server}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-telemetry": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }).catch(() => {}) : undefined;

  async function open(): Promise<Cdp | null> {
    if (!ON) return null;
    if (page) return page;
    return opening ??= (async () => {
      try {
        const base = await endpoint(cdp);
        const t = await (await fetch(`${base}/json/new?about:blank`, { method: "PUT" })).json() as any;
        const p = await cdpClient(t.webSocketDebuggerUrl);
        await p.send("Page.enable");
        if (o.headers) { await p.send("Network.enable"); await p.send("Network.setExtraHTTPHeaders", { headers: o.headers }); }
        await p.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await p.send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
        p.on("Page.screencastFrame", (f: any) => {
          p.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
          const now = Date.now();
          if (now - last < GAP) return;   // ~6 fps locally, ~3 from a VM
          last = now;
          post("/frame", { worker: role, jpeg: f.data, url, caption, local, at: now });
        });
        await p.send("Page.startScreencast", { format: "jpeg", quality: Q, maxWidth: remote ? 800 : W, maxHeight: remote ? 500 : H, everyNthFrame: 1 });
        // never blank on the wall: a static page sends no screencast frames, so resend a still about once a second
        still = setInterval(async () => {
          if (Date.now() - last < IDLE) return;
          const f = await p.send("Page.captureScreenshot", { format: "jpeg", quality: Q }).catch(() => null);
          if (f?.data) { last = Date.now(); post("/frame", { worker: role, jpeg: f.data, url, caption, local, idle: true, at: last }); }
        }, 1000);
        page = p;
        return p;
      } catch (e) {
        report("event", { eventKind: "error", text: `${role} browser unavailable: ${String(e).slice(0, 120)}`, quiet: true });
        return null;
      } finally { opening = null; }
    })();
  }

  const sleep = (ms: number) => Bun.sleep(ms);
  const evaluate = async (p: Cdp, fn: string, arg: unknown) =>
    (await p.send("Runtime.evaluate", { expression: `(${fn})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true }).catch(() => null))?.result?.value;
  const load = (p: Cdp, go: () => Promise<any>, ms = 15000) => new Promise<boolean>(async res => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res(false); } }, ms);
    p.on("Page.domContentEventFired", () => { if (!done) { done = true; clearTimeout(t); res(true); } });
    try { const r = await go(); if (r?.errorText) { done = true; clearTimeout(t); res(false); } } catch { done = true; clearTimeout(t); res(false); }
  });
  // one small "live" pulse so the page repaints and the wall gets a fresh frame even on a static page
  const pulse = (p: Cdp) => evaluate(p, `() => { document.documentElement.style.outline = document.documentElement.style.outline ? "" : "0px solid transparent" }`, null);

  const eye: Eye = {
    async goto(u, c) {
      const p = await open(); if (!p) return false;
      caption = c; url = u; local = false;
      let ok = await load(p, () => p.send("Page.navigate", { url: u }));
      // slow pages (Brave under load) may miss the event yet have content: count them as loaded
      if (!ok) ok = (await evaluate(p, `() => (document.body?.innerText ?? "").length`, null) ?? 0) > 300;
      if (!ok) caption = `${c} (page did not load)`;
      await sleep(1200); await pulse(p);
      return ok;
    },
    async view(name, html, c) {
      const p = await open(); if (!p) return;
      caption = c; url = `synth://${name}`; local = true;
      await load(p, () => p.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` }), 5000);
      await sleep(500); await pulse(p);
    },
    // outline the element that best matches `text` (word overlap), scroll it into view
    async highlight(text, tone = "found") {
      const p = await open(); if (!p) return false;
      const hit = await evaluate(p, String(({ text, tone }: { text: string; tone: string }) => {
        const words = [...new Set(text.toLowerCase().match(/[a-z0-9$%.,]{4,}/g) ?? [])].map(w => w.replace(/[.,]$/, ""));
        if (!words.length) return false;
        let best: Element | null = null, score = 0;
        for (const el of Array.from(document.querySelectorAll("p, li, h1, h2, h3, td, blockquote, span, div"))) {
          const t = (el as HTMLElement).innerText?.toLowerCase() ?? "";
          if (!t || t.length > 900) continue;
          const s = words.filter(w => t.includes(w)).length / words.length - t.length / 20000;
          if (s > score) { score = s; best = el; }
        }
        if (!best || score < 0.34) return false;
        const e = best as HTMLElement;
        e.scrollIntoView({ block: "center", behavior: "smooth" });
        e.style.outline = tone === "found" ? "3px solid #d8c08a" : "3px solid #e5484d";
        e.style.outlineOffset = "4px"; e.style.borderRadius = "4px";
        e.style.background = tone === "found" ? "rgba(216,192,138,.18)" : "rgba(229,72,77,.14)";
        return true;
      }), { text, tone });
      await sleep(1400);
      return !!hit;
    },
    async scroll(px = 500) {
      const p = await open(); if (!p) return;
      for (let i = 0; i < 4; i++) { await evaluate(p, `(y) => window.scrollBy({ top: y, behavior: "smooth" })`, px / 4); await sleep(260); }
    },
    // typing only ever happens on the worker's own local view, never on a website
    async type(selector, text, cps = 60) {
      const p = await open(); if (!p || !local) return;
      await evaluate(p, String(({ selector, text, cps }: any) => new Promise<void>(done => {
        const el = document.querySelector(selector) as HTMLElement; if (!el) return done();
        let i = 0; const step = Math.max(1, Math.round(cps / 20));
        const t = setInterval(() => { i += step; el.textContent = text.slice(0, i); if (i >= text.length) { clearInterval(t); done(); } }, 50);
      })), { selector, text, cps });
      await sleep(600);
    },
    async shot() {
      const p = await open(); if (!p) return null;
      return (await p.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }).catch(() => null))?.data ?? null;
    },
    async read(max = 6000) {
      const p = await open(); if (!p) return { title: "", text: "", url };
      const r = await evaluate(p, `(n) => ({ title: document.title, text: (document.body?.innerText ?? "").replace(/\\n{3,}/g, "\\n\\n").slice(0, n) })`, max);
      return { title: r?.title ?? "", text: r?.text ?? "", url };
    },
    async evaluate(fn, arg) { const p = await open(); return p ? evaluate(p, fn, arg ?? null) : undefined; },
    where: () => url,
    async close() { if (still) clearInterval(still); const p = page; page = null; await p?.send("Page.close").catch(() => {}); },
    async viewport(w, h, mobile = false) {
      const p = await open(); if (!p) return;
      await p.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }).catch(() => {});
      await p.send("Network.setUserAgentOverride", { userAgent: mobile ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" }).catch(() => {});
    },
    mark(kind, text = "") { if (ON) post("/frame/mark", { worker: role, kind, text, at: Date.now() }); },
    run(fn) { if (ON) queue = queue.then(fn).catch(() => {}); },
  };
  return eye;
}

// ---- local views each worker renders on its own tab (black + champagne, no emoji) ----
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const shell = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#0b0b0c;color:#ecebe8;font:24px/1.45 -apple-system,Inter,Helvetica,sans-serif;padding:30px 36px}
h1{font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:#d8c08a;margin:0 0 18px;font-weight:600}
.muted{color:#8c8a84}.box{border:1px solid #2a2927;border-radius:10px;padding:16px 18px;background:#121213}
.hl{outline:3px solid #d8c08a;outline-offset:3px;background:rgba(216,192,138,.16);border-radius:6px}.bad{outline:3px solid #e5484d;background:rgba(229,72,77,.14);border-radius:6px}
.row{display:flex;gap:14px;padding:6px 0;border-bottom:1px solid #1d1c1b}.t{color:#8c8a84;width:110px;flex:none;font-variant-numeric:tabular-nums}.who{color:#d8c08a;width:150px;flex:none}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

export const views = {
  compose(to: string, subject: string) {
    return shell("Echo · compose", `<div class="box"><div class="row"><span class="t">To</span><span>${esc(to)}</span></div>
<div class="row"><span class="t">Subject</span><span id="subj">${esc(subject)}</span></div>
<pre id="body" style="white-space:pre-wrap;font:24px/1.5 -apple-system,Inter,sans-serif;min-height:380px;margin:14px 0 0"></pre></div>`);
  },
  transcript(lines: { id: number; t: string; speaker: string; text: string }[], hot: number[], title = "Conversation", bad: number[] = []) {
    return shell(title, `<div class="box">${lines.map(l => `<div class="row ${hot.includes(l.id) ? "hl" : bad.includes(l.id) ? "bad" : ""}" id="l${l.id}"><span class="t">${esc(l.t)}</span><span class="who">${esc(l.speaker)}</span><span>${esc(l.text)}</span></div>`).join("")}</div>
<script>document.querySelector(".hl,.bad")?.scrollIntoView({block:"center"})</script>`);
  },
  blocked(issues: { claim: string; note?: string }[], version: number) {
    return shell(`Chief · v${version} blocked`, `<div class="box" style="border-color:#e5484d">${issues.map(i => `<div class="row"><span class="who" style="color:#e5484d">BLOCKED</span><span>${esc(i.claim)}<br><span class="muted">${esc(i.note ?? "no evidence")}</span></span></div>`).join("")}</div>`);
  },
  standby(role: string, focus: string, steps: string[]) {
    return shell(`${role} · standing by`, `<div style="font-size:40px;font-weight:600;margin:10px 0 6px">${esc(role)}</div>
<div class="muted" style="margin-bottom:26px">Checks ${esc(focus)}. Joins the Band room only when Chief recruits it, and leaves when its check is done.</div>
<div class="box">${steps.map((x, i) => `<div class="row"><span class="t">${i + 1}</span><span>${esc(x)}</span></div>`).join("")}</div>`);
  },
  // a week of free/busy blocks only: never event titles (the video is public)
  calendar(title: string, busy: { day: number; from: number; to: number }[], pick?: { day: number; at: number; label: string }, note = "") {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri"], hours = Array.from({ length: 10 }, (_, i) => 8 + i);
    const cell = (d: number, h: number) => {
      const b = busy.some(x => x.day === d && h >= x.from && h < x.to);
      const p = pick && pick.day === d && Math.floor(pick.at) === h;
      return `<td style="height:38px;border:1px solid #1d1c1b;${b ? "background:#26241f;" : ""}${p ? "outline:3px solid #d8c08a;outline-offset:-3px;background:rgba(216,192,138,.25);" : ""}">${p ? `<span style="color:#d8c08a;font-size:12px;padding:0 6px">${esc(pick!.label)}</span>` : b ? `<span class="muted" style="font-size:11px;padding:0 6px">busy</span>` : ""}</td>`;
    };
    return shell(title, `<table style="width:100%;border-collapse:collapse;table-layout:fixed"><tr><th style="width:56px"></th>${days.map(d => `<th class="muted" style="font-weight:500;padding:4px">${d}</th>`).join("")}</tr>
${hours.map(h => `<tr><td class="muted" style="font-size:12px">${h > 12 ? h - 12 : h}${h >= 12 ? "pm" : "am"}</td>${days.map((_, d) => cell(d, h)).join("")}</tr>`).join("")}</table>
${note ? `<p class="muted" style="margin-top:12px">${esc(note)}</p>` : ""}`);
  },
};
