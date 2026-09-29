// Deal graph view: a force graph of one run (transcript lines, sources, claims, decisions). Tap a claim to light up
// its path back to the second it was said or the source it came from; BLOCKED decisions are red. Live: refetches when
// the room moves (SSE /events), with a slow poll as a fallback.
// Real runs only by default (runs started from George's own texts or recordings); "Show rehearsals" (or ?rehearsals=1)
// includes rehearsal and untagged runs. ?run=<id> pins one run whatever its kind, and the header says which kind it is.
(function () {
  const q = new URLSearchParams(location.search);
  let runId = q.get("run") || "", rehearsals = q.get("rehearsals") === "1";
  const pinned = !!runId;
  const tog = document.getElementById("tog");
  const showTog = () => tog.setAttribute("aria-pressed", String(rehearsals));
  showTog();
  tog.onclick = () => {
    rehearsals = !rehearsals; showTog();
    const u = new URL(location.href);
    if (rehearsals) u.searchParams.set("rehearsals", "1"); else u.searchParams.delete("rehearsals");
    try { history.replaceState(null, "", u); } catch {}
    load();
  };
  const svg = d3.select("#g"), root = svg.append("g"), gE = root.append("g"), gN = root.append("g");
  svg.call(d3.zoom().scaleExtent([0.3, 4]).on("zoom", e => root.attr("transform", e.transform)));
  svg.on("click", e => { if (e.target === svg.node()) clearSel(); });
  document.getElementById("close").onclick = clearSel;

  const W = () => innerWidth, H = () => innerHeight;
  const COL = { Person: 0.06, TranscriptLine: 0.18, Source: 0.22, Commitment: 0.34, Claim: 0.46, Decision: 0.66, Run: 0.46 };
  const sim = d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d.id).distance(l => (l.type === "SAID" ? 34 : l.type === "ON" ? 60 : l.type === "REVISES" ? 110 : 90)).strength(0.5))
    .force("charge", d3.forceManyBody().strength(-260))
    .force("x", d3.forceX(d => (COL[d.label] ?? 0.5) * W()).strength(0.12))
    .force("y", d3.forceY(() => H() * 0.52).strength(0.04))
    .force("collide", d3.forceCollide(d => (d.label === "Claim" ? 34 : d.label === "Decision" ? 24 : 18)))
    .on("tick", tick);

  let nodes = [], edges = [], sel = null, hot = null;
  const verdictOf = new Map(); // claim id → latest verdict on it
  const short = (s, n) => (s = String(s || ""), s.length > n ? s.slice(0, n - 1) + "…" : s);
  const shown = v => (v === "VETO" ? "BLOCKED" : v);
  const label = d => d.label === "Claim" ? short(d.text, 34) + (d.version > 1 ? `  v${d.version}` : "")
    : d.label === "Decision" ? shown(d.verdict) + " · " + (d.by || "")
    : d.label === "TranscriptLine" ? `${d.speaker || "?"} ${d.t ?? ""}`
    : d.label === "Source" ? short(d.title || d.url || d.id, 26)
    : d.label === "Commitment" ? "Promise: " + short(d.text, 24) : short(d.text, 24);

  function draw(g) {
    const old = new Map(nodes.map(n => [n.id, n]));
    nodes = g.nodes.map(n => Object.assign(old.get(n.id) || { x: (COL[n.label] ?? 0.5) * W() + (Math.random() - 0.5) * 60, y: H() / 2 + (Math.random() - 0.5) * 200 }, n));
    const ids = new Set(nodes.map(n => n.id));
    edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map(e => ({ source: e.from, target: e.to, type: e.type }));
    verdictOf.clear();
    const decs = nodes.filter(n => n.label === "Decision").sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const d of decs) for (const e of g.edges) if (e.type === "ON" && e.from === d.id) verdictOf.set(e.to, d.verdict);

    const es = gE.selectAll("line").data(edges, d => `${d.source.id || d.source}>${d.type}>${d.target.id || d.target}`);
    es.exit().remove();
    es.enter().append("line").attr("class", d => "edge " + d.type);
    const ns = gN.selectAll("g.node").data(nodes, d => d.id);
    ns.exit().remove();
    const ne = ns.enter().append("g").attr("class", d => "node " + d.label)
      .on("click", (e, d) => { e.stopPropagation(); if (d.label === "Claim") select(d); })
      .call(d3.drag().on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; }).on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = d.fy = null; }));
    ne.append("path");
    ne.append("text").attr("x", 13).attr("y", 4);
    gN.selectAll("g.node").each(function (d) {
      const g = d3.select(this), v = verdictOf.get(d.id);
      const shape = d.label === "Decision" ? d3.symbolDiamond : d.label === "Commitment" ? d3.symbolSquare : d3.symbolCircle;
      const size = d.label === "Claim" ? 260 : d.label === "Person" ? 220 : d.label === "Decision" ? 150 : 110;
      const fill = d.label === "Claim" ? (v === "VETO" ? "#000" : "#ecd3a0") : d.label === "Decision" ? (d.verdict === "VETO" ? "#ff4d4f" : d.verdict === "APPROVED" ? "#fff" : "#ecd3a0")
        : d.label === "TranscriptLine" ? "#fff" : d.label === "Person" ? "#000" : d.label === "Commitment" ? "#000" : "#636366";
      const stroke = d.label === "Claim" ? (v === "VETO" ? "#ff4d4f" : "#ecd3a0") : d.label === "Person" ? "#fff" : d.label === "Commitment" ? "#ecd3a0" : "none";
      g.select("path").attr("d", d3.symbol(shape, size)).attr("fill", fill).attr("stroke", stroke).attr("stroke-width", 2.2);
      g.select("text").text(label(d)).attr("fill", d.label === "Decision" && d.verdict === "VETO" ? "#ff8a8c" : null);
    });
    sim.nodes(nodes); sim.force("link").links(edges); sim.alpha(old.size ? 0.25 : 1).restart();
    const c = nodes.filter(n => n.label === "Claim").length, b = [...verdictOf.values()].filter(v => v === "VETO").length;
    document.getElementById("meta").textContent = nodes.length ? `${c} claims · ${b} blocked · ${nodes.filter(n => n.label === "TranscriptLine").length} transcript lines · ${nodes.filter(n => n.label === "Source").length} sources` : "";
    const empty = document.getElementById("empty");
    empty.style.display = nodes.length ? "none" : "grid";
    empty.textContent = g.run ? "Nothing recorded in this run yet." : rehearsals ? "Waiting for the first run…" : "No real runs yet. Rehearsals are hidden: tap Show rehearsals.";
    if (sel) paint();
  }

  function tick() {
    gE.selectAll("line").attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    gN.selectAll("g.node").attr("transform", d => `translate(${d.x},${d.y})`);
  }

  async function select(d) {
    sel = d.id;
    const p = await fetch("/api/graph/path?claim=" + encodeURIComponent(d.id)).then(r => r.json()).catch(() => ({ nodes: [], edges: [] }));
    if (sel !== d.id) return;
    hot = { ids: new Set(p.nodes.map(n => n.id)), edges: new Set(p.edges.map(e => `${e.from}>${e.to}`)) };
    paint(); side(p);
  }
  function clearSel() { sel = hot = null; paint(); document.getElementById("side").classList.remove("on"); }
  function paint() {
    gN.selectAll("g.node").classed("dim", d => !!hot && !hot.ids.has(d.id));
    gE.selectAll("line").each(function (e) {
      const k = `${e.source.id}>${e.target.id}`, on = !!hot && hot.edges.has(k);
      d3.select(this).classed("hot", on).classed("veto", on && e.type === "ON" && e.source.verdict === "VETO").classed("dim", !!hot && !on);
    });
  }

  // The side panel tells the path as a story: each version, what it cites (or "no source"), and the decisions on it.
  function side(p) {
    const box = document.getElementById("path"); box.textContent = "";
    const by = id => p.nodes.find(n => n.id === id);
    const claims = p.nodes.filter(n => n.label === "Claim").sort((a, b) => (a.version || 0) - (b.version || 0));
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    for (const c of claims) {
      const decs = p.edges.filter(e => e.type === "ON" && e.to === c.id).map(e => by(e.from)).filter(Boolean).sort((a, b) => (a.at || 0) - (b.at || 0));
      const cites = p.edges.filter(e => e.type === "CITES" && e.from === c.id).map(e => by(e.to)).filter(Boolean);
      const v = el("div", "ver" + (decs.some(x => x.verdict === "VETO") ? " veto" : "") + (c.version < claims.length ? " old" : ""));
      v.append(el("div", "v", `v${c.version || 1} · written by ${c.by || "?"}`), el("q", "", c.text));
      if (!cites.length) v.append(el("div", "none", "No source: not in the transcript, not in any finding"));
      for (const s of cites) {
        const ev = el("div", "ev");
        if (s.label === "TranscriptLine") { ev.append(el("span", "who", `${s.speaker || "?"} at ${s.t ?? "?"}`), document.createTextNode(`: “${s.body ?? s.text ?? ""}”`)); }
        else {
          ev.append(document.createTextNode(`${s.kind || "source"}: `));
          if (s.url && /^https:\/\//.test(s.url)) { const a = el("a", "", s.title || s.url); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer"; ev.append(a); }
          else ev.append(document.createTextNode(s.title || s.id));
        }
        v.append(ev);
      }
      for (const d of decs) { v.append(el("span", "dec " + d.verdict, shown(d.verdict)), el("small", "", `${d.by}${d.reason ? ": " + d.reason : ""}`), el("br")); }
      box.append(v);
    }
    if (!claims.length) box.append(el("div", "ev", "Nothing recorded for this claim yet."));
    document.getElementById("side").classList.add("on");
  }

  let busy = false, again = false;
  async function load() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      // Not pinned: the server picks the newest run of the kinds shown, so a new rehearsal never replaces the real one.
      const qs = pinned ? "?run=" + encodeURIComponent(runId) : rehearsals ? "?rehearsals=1" : "";
      const g = await fetch("/api/graph" + qs).then(r => r.json());
      if (!pinned && g.run !== runId) { runId = g.run || ""; clearSel(); nodes = []; }
      document.getElementById("run").textContent = g.run ? `run ${g.run}` : "";
      const k = document.getElementById("kind");
      k.textContent = g.run ? (g.kind === "real" ? "real" : "rehearsal") : ""; k.className = "kind " + (g.kind === "real" ? "real" : "");
      draw(g);
    } catch (e) { /* keep the last picture */ }
    busy = false;
    if (again) { again = false; load(); }
  }
  let t; const soon = () => { clearTimeout(t); t = setTimeout(load, 700); };
  try {
    const es = new EventSource("/events"), live = document.getElementById("live");
    es.onopen = () => live.classList.add("on"); es.onerror = () => live.classList.remove("on");
    es.addEventListener("run", soon);
    es.addEventListener("line", soon); es.addEventListener("card", soon);
  } catch {}
  setInterval(load, 6000);
  addEventListener("resize", () => sim.alpha(0.3).restart());
  load();
})();
