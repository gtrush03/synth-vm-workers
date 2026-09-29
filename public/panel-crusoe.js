// Crusoe router panel: one row per model call, from the server's existing SSE (/events → "meter" events, meter.last).
// Prices: Crusoe Managed Inference list prices, $ per 1M tokens (input, output), crusoe.ai/cloud/pricing, 29 Sep 2026.
// When a call reports only total tokens, $ is an upper bound (every token at the output rate) and shows "≤".
(function () {
  const RATES = {
    "deepseek-ai/deepseek-v4-pro": [1.74, 3.48],
    "deepseek-ai/deepseek-v4-flash": [0.14, 0.28],
    "openai/gpt-oss-120b": [0.05, 0.2],
  };
  const rate = c => (c.provider === "openrouter" && /:free$/.test(c.model || "") ? [0, 0] : c.provider === "mock" ? [0, 0] : RATES[String(c.model || "").toLowerCase()] || null);
  function cost(c) {
    const r = rate(c);
    if (!r) return null;
    if (c.inTokens != null && c.outTokens != null) return { usd: (c.inTokens * r[0] + c.outTokens * r[1]) / 1e6, bound: false };
    return { usd: ((c.tokens || 0) * r[1]) / 1e6, bound: true };
  }
  const usd = x => (x == null ? "–" : x === 0 ? "$0" : x < 0.001 ? "$" + x.toFixed(5) : x < 1 ? "$" + x.toFixed(4) : "$" + x.toFixed(2));
  const fmtCost = k => (k ? (k.bound && k.usd > 0 ? "≤ " : "") + usd(k.usd) : "–");
  const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let calls = [], lastCount = 0, primary = {}; // role → "crusoe" | "openrouter" (from the tiles)
  // A fallback is either reported by the server (c.fallbacks) or inferred: a Crusoe-first role answered by OpenRouter.
  const fallbacksOf = c => (Array.isArray(c.fallbacks) && c.fallbacks.length ? c.fallbacks
    : c.provider === "openrouter" && primary[c.worker] !== "openrouter" ? ["Crusoe → OpenRouter"] : []);

  let lastRun = null;
  function add(c, fresh) {
    if (!c || !c.model) return;
    if (c.runId && lastRun && c.runId !== lastRun) calls.unshift({ kind: "sep", text: `Run ${lastRun} above · run ${c.runId} below`, at: Date.now() });
    if (c.runId) lastRun = c.runId;
    calls.unshift(Object.assign({ at: c.at || Date.now() }, c, { fresh }));
    calls = calls.slice(0, 400);
  }
  function render() {
    const real = calls.filter(c => c.kind !== "sep");
    const ms = real.map(c => c.ms).filter(x => x > 0), costs = real.map(cost).filter(Boolean);
    $("c-calls").textContent = real.length;
    $("c-ms").textContent = ms.length ? median(ms).toLocaleString() + " ms" : "–";
    $("c-tok").textContent = real.reduce((a, c) => a + (c.tokens || 0), 0).toLocaleString();
    const spend = costs.reduce((a, k) => a + k.usd, 0), bound = costs.some(k => k.bound && k.usd > 0);
    $("c-usd").textContent = costs.length ? (bound ? "≤ " : "") + usd(spend) : "–";
    $("c-fb").textContent = real.filter(c => fallbacksOf(c).length).length;

    const by = new Map();
    for (const c of real) { const k = `${c.provider}|${c.model}`; (by.get(k) || by.set(k, []).get(k)).push(c); }
    const mb = $("models"); mb.textContent = "";
    for (const [k, xs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      const [prov, model] = k.split("|"), r = rate(xs[0]), m = xs.map(c => c.ms).filter(x => x > 0), ks = xs.map(cost).filter(Boolean);
      const tr = el("tr");
      tr.append(el("td", "model", (prov === "crusoe" ? "Crusoe · " : prov === "openrouter" ? "OpenRouter · " : "") + model),
        el("td", "role", [...new Set(xs.map(c => c.worker))].join(", ")), el("td", "n", xs.length),
        el("td", "n", m.length ? median(m).toLocaleString() : "–"), el("td", "n", m.length ? Math.max(...m).toLocaleString() : "–"),
        el("td", "n", Math.round(xs.reduce((a, c) => a + (c.tokens || 0), 0) / xs.length).toLocaleString()),
        el("td", "n", ks.length ? (ks.some(x => x.bound && x.usd > 0) ? "≤ " : "") + usd(ks.reduce((a, x) => a + x.usd, 0) / ks.length) : "–"),
        el("td", "n", r ? (r[0] === 0 && r[1] === 0 ? "free" : `$${r[0]} · $${r[1]}`) : "–"),
        el("td", "n" + (xs.some(c => fallbacksOf(c).length) ? " fb" : ""), xs.filter(c => fallbacksOf(c).length).length));
      mb.append(tr);
    }

    const cb = $("calls"); cb.textContent = "";
    for (const c of calls.slice(0, 120)) {
      if (c.kind === "sep") { const tr = el("tr", "sep"); const td = el("td", "", c.text); td.colSpan = 8; tr.append(td); cb.append(tr); continue; }
      const fb = fallbacksOf(c), tr = el("tr", c.fresh ? "new" : "");
      tr.append(el("td", "", new Date(c.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })),
        el("td", "role", c.worker || "?"), el("td", "", c.label || ""),
        el("td", "model", (c.provider === "crusoe" ? "Crusoe · " : c.provider === "openrouter" ? "OpenRouter · " : c.provider + " · ") + c.model),
        el("td", "n", (c.ms || 0).toLocaleString()), el("td", "n", (c.tokens || 0).toLocaleString()), el("td", "n", fmtCost(cost(c))),
        el("td", fb.length ? "fb" : "ok", fb.length ? fb.join(" · ") : "none"));
      cb.append(tr); c.fresh = false;
    }
    $("note").textContent = "Prices: Crusoe Managed Inference list prices per 1M tokens (crusoe.ai/cloud/pricing). "
      + (bound ? "≤ means an upper bound: the call reported total tokens only, so every token is counted at the output rate. " : "")
      + "OpenRouter :free models cost $0.";
  }

  function onMeter(m, fresh) {
    if (!m) return;
    if (m.calls < lastCount && !m.last?.runId) calls.unshift({ kind: "sep", text: "New run", at: Date.now() });
    if (m.last && (m.calls > lastCount || m.calls < lastCount)) add(m.last, fresh);
    lastCount = m.calls;
    render();
  }
  function onTiles(tiles) {
    for (const t of Object.values(tiles || {})) primary[t.name] = /OpenRouter/i.test(t.model || "") ? "openrouter" : "crusoe";
  }
  const live = $("live");
  const es = new EventSource("/events");
  es.onopen = () => live.classList.add("on");
  es.onerror = () => live.classList.remove("on");
  es.addEventListener("hello", e => {
    try {
      const s = JSON.parse(e.data); onTiles(s.tiles);
      if (Array.isArray(s.meter?.history) && !calls.length) { for (const c of s.meter.history) add(c, false); lastCount = s.meter.calls || 0; render(); }
      else onMeter(s.meter, false);
    } catch {}
  });
  es.addEventListener("meter", e => { try { onMeter(JSON.parse(e.data), true); } catch {} });
  es.addEventListener("tile", e => { try { const t = JSON.parse(e.data); onTiles({ [t.name]: t }); } catch {} });
  render();
})();
