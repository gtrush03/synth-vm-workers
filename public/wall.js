// Live wall: every Synth's own browser on the big screen, the Band room beside it, BLOCKED on the tile that caused it,
// and the approved email landing as a card at the end.
//   /frames (SSE): "frame" {worker, jpeg(base64), url, caption, at, local?}   "mark" {worker, kind: block|found|notfound|clear, text, at}
//   /events (SSE): "hello" snapshot, "tile", "line", "run", "card"  (the same stream the room view uses)
// Keys: 1-9 enlarge that tile, Esc closes. ?tiles=Scout,Echo picks the tiles. ?sample=1 reads the preview's sample stream.
// ?synth=<id>[&task=<taskId>]: one Synth's live browser, phone-first: the "watch it live" link on its app card. With a task
// it shows the task from /api/proof/<taskId> and, once done or failed, a button to its proof page.
(function () {
  const q = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const CHECKERS = ["FactCheck", "Pricing", "Tech", "Legal", "PartnerCheck"];
  const PICK = (q.get("tiles") || "").split(",").map(s => s.trim()).filter(Boolean);
  const LIVE_MS = 3000;
  const SOLO = (q.get("synth") || "").trim().slice(0, 64), TASK = (q.get("task") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  let soloName = SOLO, task = null;
  const log = [];      // solo: the Synth's recent actions
  if (SOLO) {
    document.body.classList.add("solo"); document.documentElement.style.overflow = "auto"; document.title = `${SOLO} · live browser`;
    const h = document.querySelector("header h1"); h.textContent = "SYNTH "; h.append(el("b", "", "live"));
  }

  let tiles = {}, run = null, lines = [];
  const frames = {};   // worker → { bmp, at, got, url, caption, local, sample }
  const blocks = {};   // worker → { text, at, mark }
  const proofs = {};   // worker → { kind, text, at }
  const acts = {};     // worker → { text, at }
  const views = {};    // worker → { small, big? }
  let bigWorker = null, landedFor = null;
  const shownCheckers = new Set();

  // ---------- which tiles ----------
  function order() {
    if (SOLO) return [soloName];
    if (PICK.length) return PICK;
    // a checker gets a tile once it's recruited in this run (in the room, busy, or doing more than its idle "Standing by"
    // frame), and keeps it for the rest of the run so the grid doesn't jump
    const recruited = w => tiles[w]?.inRoom || /work|think|writ|check|search|brows/i.test(tiles[w]?.status || "")
      || (acts[w] && !/^standing by/i.test(acts[w].text) && (!run?.started || acts[w].at >= run.started));
    for (const w of CHECKERS) if (recruited(w)) shownCheckers.add(w);
    const checkers = CHECKERS.filter(w => shownCheckers.has(w));
    const base = ["Scout", "Echo", "Chief", ...(checkers.length ? checkers : ["FactCheck"]), "Scheduler", "Counterparty"];
    for (const w of Object.keys(frames)) if (!base.includes(w) && !CHECKERS.includes(w)) base.push(w);
    return base;
  }

  // ---------- labels ----------
  const tileOf = w => tiles[w] || Object.values(tiles).find(t => same(t?.name, w)) || (SOLO && task ? { identity: task.where, model: task.model, status: task.status } : null);
  const CITY = { sjc: "San Jose", lax: "Los Angeles", sea: "Seattle", ord: "Chicago", dfw: "Dallas", atl: "Atlanta", mia: "Miami", ewr: "New Jersey",
    yto: "Toronto", mex: "Mexico City", sao: "São Paulo", scl: "Santiago", hnl: "Honolulu", ams: "Amsterdam", fra: "Frankfurt", lhr: "London", man: "Manchester",
    cdg: "Paris", mad: "Madrid", waw: "Warsaw", sto: "Stockholm", nrt: "Tokyo", itm: "Osaka", icn: "Seoul", sgp: "Singapore", bom: "Mumbai", blr: "Bangalore",
    del: "Delhi", syd: "Sydney", mel: "Melbourne", jnb: "Johannesburg", tlv: "Tel Aviv" };
  const where = t => {
    const id = t?.identity;
    if (id?.vm && id?.region) return { text: `Vultr · ${CITY[String(id.region).toLowerCase()] || String(id.region).toUpperCase()} · ${String(id.vm).slice(0, 8)}`, vm: true };
    if (id?.host && !id?.vm) return { text: "this Mac", vm: false };
    return { text: "", vm: false };   // not reported yet: say nothing rather than guess
  };
  const model = t => {
    const m = String(t?.model || "");
    if (!m) return "";
    const [prov, rest] = m.includes(" · ") ? m.split(" · ") : ["", m];
    const name = rest.includes("/") ? rest.split("/").pop() : rest;
    return (prov ? prov.replace(/^via\s+/i, "") + " · " : "") + name;
  };
  const busyTile = t => !!t?.detail && !/^(joined|off|idle)$/.test(t.status || "") && t.detail !== "Band";
  const oneLine = s => String(s || "").replace(/@\w+\s*/g, "").split("\n").map(x => x.trim()).filter(Boolean)[0] || "";
  const short = (s, n) => (s = String(s || ""), s.length > n ? s.slice(0, n - 1) + "…" : s);

  // Deal Room workers keep their names; a TEAM Synth id ("growth") shows as "Growth Synth"
  const display = w => (tiles[w] || /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1) + " Synth");

  // ---------- tile DOM ----------
  function mkView(w, big) {
    const root = el("div", "tile"), th = el("div", "th"), fr = el("div", "fr");
    const n = el("span", "n", display(w)), k1 = el("span", "k where"), k2 = el("span", "k"), st = el("span", "st");
    st.append(el("i"), el("span", "", ""));
    th.append(n, k1, st);
    const cv = el("canvas"), addr = el("div", "addr off"), wait = el("div", "wait"), proof = el("div", "proof"), blk = el("div", "blk");
    wait.append(el("b", "", display(w)), el("span", "", "Ready. Starts browsing when a task begins."));
    blk.append(el("b", "", "BLOCKED"), el("p"));
    fr.append(cv, addr, wait, proof, blk);
    const act = el("div", "act"), foot = el("div", "foot");
    foot.append(act, k2);
    root.append(th, fr, foot);
    root.onclick = e => { e.stopPropagation(); big ? closeBig() : openBig(w); };
    return { root, n, k1, k2, st: st.lastChild, cv, addr, wait, proof, blk: blk.lastChild, act, ctx: cv.getContext("2d") };
  }
  function viewsOf(w) { const v = views[w]; return v ? [v.small, v.big].filter(Boolean) : []; }

  function layout() {
    const ws = order(), grid = $("grid");
    for (const w of Object.keys(views)) if (!ws.includes(w)) { views[w].small.root.remove(); delete views[w]; }
    ws.forEach((w, i) => {
      if (!views[w]) { views[w] = { small: mkView(w, false) }; paintAll(w); }
      const r = views[w].small.root;
      if (grid.children[i] !== r) grid.insertBefore(r, grid.children[i] || $("big"));
    });
    fit();
  }
  // biggest 16:10 tiles that fit the grid area
  function fit() {
    const grid = $("grid"), n = order().length; if (!n) return;
    if (SOLO) { grid.style.gridTemplateColumns = "minmax(0, 1fr)"; return; }
    grid.style.gridTemplateColumns = "";   // measure the box itself, not the last layout's tiles
    const cs = getComputedStyle(grid), gap = parseFloat(cs.columnGap) || 12;
    const W = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = grid.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const any = grid.querySelector(".tile"), chrome = any ? any.offsetHeight - any.querySelector(".fr").offsetHeight : 90;
    let best = { w: 0, c: 1 };
    if (innerWidth < 900) {   // narrow screens scroll: fit the width only
      const c = W >= 560 ? 2 : 1, w = Math.floor((W - gap * (c - 1)) / c);
      grid.style.gridTemplateColumns = `repeat(${c}, ${w}px)`; return;
    }
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const w = Math.min((W - gap * (c - 1)) / c, ((H - gap * (r - 1)) / r - chrome) / 0.625);
      if (w > best.w) best = { w, c };
    }
    let w = Math.max(80, Math.floor(best.w));
    grid.style.gridTemplateColumns = `repeat(${best.c}, ${w}px)`;
    for (let i = 0; i < 20 && grid.scrollWidth > grid.clientWidth + 1; i++) { w = Math.floor(w * 0.95); grid.style.gridTemplateColumns = `repeat(${best.c}, ${w}px)`; }
  }

  // ---------- painting ----------
  function paintAll(w) { paintHead(w); paintFrame(w); paintAct(w); paintMarks(w); }
  function paintHead(w) {
    const t = tileOf(w), wh = where(t), m = model(t);
    for (const v of viewsOf(w)) {
      v.k1.textContent = wh.text; v.k1.className = "k where" + (wh.vm ? " vm" : ""); v.k1.style.display = wh.text ? "" : "none";
      v.k2.textContent = m; v.k2.style.display = m ? "" : "none";
      if (SOLO && task?.synthName) v.n.textContent = task.synthName;
    }
    paintLive(w);
  }
  function paintLive(w) {
    const f = frames[w], t = tileOf(w), now = Date.now();
    const on = !!f && now - f.got < LIVE_MS;
    const label = !f ? (t?.status && t.status !== "off" ? t.status : "no browser yet") : f.sample ? "sample" : f.hidden ? (on ? "live · private" : "private view") : on ? "live" : `idle · ${Math.round((now - f.got) / 1000)} s`;
    for (const v of viewsOf(w)) {
      v.st.textContent = label;
      v.root.classList.toggle("live-now", on && !f.sample);
      v.root.classList.toggle("active", !!(t?.inRoom || on));
    }
  }
  function paintFrame(w) {
    const f = frames[w];
    for (const v of viewsOf(w)) {
      v.wait.lastChild.textContent = f?.hidden ? "Working in a private view: not shown on the public page." : "Ready. Starts browsing when a task begins.";
      if (!f?.bmp) { v.wait.style.display = ""; v.cv.classList.remove("on"); v.addr.classList.add("off"); continue; }
      if (v.cv.width !== f.bmp.width || v.cv.height !== f.bmp.height) { v.cv.width = f.bmp.width; v.cv.height = f.bmp.height; }
      v.ctx.drawImage(f.bmp, 0, 0);
      v.cv.classList.add("on"); v.wait.style.display = "none";
      v.addr.textContent = "";
      if (f.url) {
        if (f.local) v.addr.append(el("em", "", "own view"));
        if (f.sample) v.addr.append(el("em", "", "sample"));
        v.addr.append(el("span", "", String(f.url).replace(/^https?:\/\//, "")));
      }
      v.addr.classList.toggle("off", !f.url);
    }
  }
  function paintAct(w) {
    const a = acts[w], t = tileOf(w);
    const text = a?.text || (busyTile(t) ? t.detail : "") || "";
    for (const v of viewsOf(w)) {
      v.act.textContent = "";
      if (text) v.act.append(el("b", "", "▸ "), document.createTextNode(text)); else v.act.append(el("span", "", " "));
      v.act.title = text;
    }
  }
  function paintMarks(w) {
    const b = blocks[w], p = proofs[w];
    for (const v of viewsOf(w)) {
      v.root.classList.toggle("blocked", !!b);
      v.blk.textContent = b ? b.text : "";
      v.proof.className = "proof" + (p ? " on" + (p.kind === "notfound" ? " bad" : "") : "");
      v.proof.textContent = "";
      if (p) { v.proof.append(document.createTextNode(p.kind === "notfound" ? "✗ NOT FOUND on this page" : "✓ FOUND on this page")); if (p.text) v.proof.append(el("small", "", p.text)); }
    }
  }
  const setAct = (w, text, at) => {
    if (!text) return; const t = at || Date.now(); if (acts[w] && acts[w].at > t) return;
    acts[w] = { text: short(text, 160), at: t }; paintAct(w);
    if (SOLO && same(w, soloName) && log[0]?.text !== acts[w].text) { log.unshift(acts[w]); log.length = Math.min(log.length, 12); paintSolo(); }
  };

  // ---------- enlarge ----------
  function openBig(w) {
    closeBig();
    bigWorker = w;
    const v = mkView(w, true), big = $("big");
    (views[w] ||= { small: mkView(w, false) }).big = v;
    big.append(v.root); big.classList.add("on");
    paintAll(w);
  }
  function closeBig() {
    const big = $("big");
    if (bigWorker && views[bigWorker]) delete views[bigWorker].big;
    bigWorker = null; big.textContent = ""; big.classList.remove("on");
  }
  $("big").onclick = closeBig;
  addEventListener("keydown", e => {
    if (e.key === "Escape") { closeBig(); $("land").classList.remove("on"); }
    const n = Number(e.key); if (n >= 1 && n <= 9) { const w = order()[n - 1]; if (w) (bigWorker === w ? closeBig() : openBig(w)); }
  });

  // ---------- frames: decode off the event, draw only the newest ----------
  const pending = {}, busy = {};
  async function decode(w) {
    if (busy[w]) return;
    busy[w] = true;
    while (pending[w]) {
      const f = pending[w]; pending[w] = null;
      try {
        const bin = atob(f.jpeg), u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u8], { type: "image/jpeg" }));
        if (frames[w]?.hidden && (f.at || 0) <= frames[w].at) { bmp.close?.(); continue; }   // a private view came in meanwhile
        const old = frames[w]?.bmp;
        frames[w] = { bmp, at: f.at || Date.now(), got: Date.now(), url: f.url, caption: f.caption, local: !!f.local, sample: !!f.sample };
        if (!views[w]) layout();
        requestAnimationFrame(() => { paintFrame(w); paintLive(w); try { old?.close?.(); } catch {} });
        if (f.caption) { setAct(w, f.caption, f.at); if (CHECKERS.includes(w) && !shownCheckers.has(w) && !/^standing by/i.test(f.caption)) layout(); }
      } catch {}
    }
    busy[w] = false;
  }
  function onFrame(f) {
    if (!f?.worker) return;
    if (!f.jpeg) { onHidden(f); return; }
    if (SOLO) { if (!same(f.worker, SOLO)) return; if (f.worker !== soloName) { soloName = f.worker; layout(); } }
    pending[f.worker] = f; decode(f.worker);
  }
  // the public host blanks a Synth's own private views (transcript, promises): jpeg "" → a neutral placeholder, never a stale frame
  function onHidden(f) {
    if (SOLO) { if (!same(f.worker, SOLO)) return; if (f.worker !== soloName) { soloName = f.worker; layout(); } }
    const w = f.worker, old = frames[w]?.bmp;
    pending[w] = null;
    frames[w] = { bmp: null, hidden: true, at: f.at || Date.now(), got: Date.now(), url: f.url, local: true };
    if (!views[w]) layout();
    requestAnimationFrame(() => { paintFrame(w); paintLive(w); try { old?.close?.(); } catch {} });
  }
  function onMark(m) {
    if (!m?.worker) return;
    if (SOLO && !same(m.worker, soloName)) return;
    if (m.kind === "block") { blocks[m.worker] = { text: m.text || "", at: m.at || Date.now(), mark: true }; }
    else if (m.kind === "clear") { delete blocks[m.worker]; delete proofs[m.worker]; }
    else if (m.kind === "found" || m.kind === "notfound") proofs[m.worker] = { kind: m.kind, text: m.text || "", at: m.at || Date.now() };
    if (!views[m.worker]) layout();
    paintMarks(m.worker);
  }

  // ---------- the Band room ----------
  const vetoText = s => {
    const t = String(s || "").replace(/^@\w+\s*/, "").replace(/^BLOCKED\s*v?\d*\.?\s*/i, "");
    const x = t.split("\n").find(l => /^\s*✗/.test(l));
    return short((x ? x.replace(/^\s*✗\s*/, "").replace(/:\s*[^:]*$/, "") : t.split("\n")[0]).replace(/^"|"$/g, ""), 180);
  };
  function onLine(l, replay) {
    if (!l || (run && l.runId && l.runId !== run.id)) return;
    lines.push(l); if (lines.length > 200) lines = lines.slice(-200);
    if (l.kind === "message" && l.from && l.from !== "Desk") setAct(l.from, oneLine(l.text), l.at);
    if (l.from === "Chief" && l.tone === "veto") {
      const w = (l.mentions || [])[0] || "Echo";
      if (!blocks[w]?.mark) { blocks[w] = { text: vetoText(l.text), at: l.at || Date.now() }; paintMarks(w); }
    }
    if (l.tone === "pass") for (const w of Object.keys(blocks)) if (!blocks[w].mark) { delete blocks[w]; paintMarks(w); }
    // the blocked Synth sends its fix: the overlay has done its job
    if (l.kind === "message" && blocks[l.from] && !blocks[l.from].mark && (l.at || Date.now()) - blocks[l.from].at > 4000) { delete blocks[l.from]; paintMarks(l.from); }
    if (!replay) renderRoom();
  }
  function renderRoom() {
    const box = $("room"); box.textContent = "";
    const shown = lines.filter(l => l.kind !== "llm");
    for (const l of shown.slice(-40)) {
      const cls = l.tone === "veto" ? "veto" : l.tone === "pass" ? "pass" : l.kind === "thought" ? "thought" : /^tool/.test(l.kind) ? "tool" : l.kind === "message" || l.kind === "gate" ? "" : "sys";
      const m = el("div", "m " + cls);
      m.append(el("span", "f" + (l.from === "Desk" ? " desk" : ""), l.from === "Desk" ? "Room" : l.from));
      const x = el("span", "x");
      if (l.tone === "veto" && l.from === "Chief") x.append(el("span", "chip", "BLOCKED"));
      if (l.tone === "pass") x.append(el("span", "chip", "PASS"));
      const text = l.tone === "veto" && l.from === "Chief" ? String(l.text).replace(/BLOCKED\s*/, "") : String(l.text);
      for (const part of text.split(/(@\w+)/)) part.startsWith("@") ? x.append(el("u", "", part)) : x.append(document.createTextNode(part));
      m.append(x); box.append(m);
    }
    $("rcount").textContent = shown.length ? `${shown.filter(l => l.kind === "message").length} messages` : "";
  }

  // ---------- the run: header, approval, the email landing ----------
  const STATUS = { running: "working", "awaiting approval": "waiting for George", sending: "sending", shipped: "done", declined: "declined", blocked: "blocked", "timed out": "timed out", interrupted: "stopped", "send failed": "send failed" };
  function onRun(r, fromHello) {
    if (!r || SOLO) return;
    if (!run || r.id !== run.id) {
      shownCheckers.clear();
      lines = []; for (const k of Object.keys(blocks)) delete blocks[k]; for (const k of Object.keys(proofs)) delete proofs[k];
      for (const k of Object.keys(acts)) delete acts[k];
      $("land").classList.remove("on");
      run = r;
      for (const l of r.lines || []) onLine({ runId: r.id, ...l }, true);
      for (const w of Object.keys(views)) paintAll(w);
      renderRoom();
    }
    run = Object.assign(run, r, { lines: undefined });
    $("hrun").textContent = "";
    $("hrun").append(el("b", "", r.company || ""), document.createTextNode(r.subject || r.ask ? " · " + (r.subject || r.ask) : ""));
    const hk = $("hkind"); hk.textContent = r.kind === "real" ? "real" : "rehearsal"; hk.className = "tag" + (r.kind === "real" ? " real" : "");
    const hs = $("hstatus"); hs.textContent = r.status === "shipped" ? (r.sent?.ok && !r.sent?.dry ? "sent" : r.sent?.dry ? "dry run" : r.to ? "not sent" : "published") : STATUS[r.status] || r.status || "";
    hs.className = "tag " + (r.status === "shipped" ? "go" : /declin|block|timed|fail|interrupt/.test(r.status) ? "bad" : "real");
    pendingCard(r);
    if (r.status === "shipped" && fromHello) landedFor = r.id;   // already sent before the wall opened: no replayed landing
    if (r.status === "shipped" && !fromHello && landedFor !== r.id) { landedFor = r.id; land(r); }
  }
  function pendingCard(r) {
    const p = $("pending"); p.textContent = ""; p.className = "";
    const v = r.final?.version ? `v${r.final.version}` : "the draft";
    if (r.status === "awaiting approval") { p.className = "on"; p.append(el("b", "", "Waiting for George's yes"), document.createTextNode(`${v} passed Chief and is on his phone. Nothing leaves until he says yes.`)); }
    else if (r.status === "shipped") { p.className = "on"; p.append(el("b", "", r.sent?.ok && !r.sent?.dry ? "Approved and sent" : r.sent?.dry ? "Approved · dry run" : "Approved"), document.createTextNode(r.sent?.dry ? "Dry run: nothing was sent." : r.to ? `${v} went out after George said yes.` : `${v} published, no outreach sent.`)); }
    else if (r.status === "declined") { p.className = "on bad"; p.append(el("b", "", "George said not this one"), document.createTextNode("Nothing was sent.")); }
    else if (/timed out|send failed/.test(r.status)) { p.className = "on bad"; p.append(el("b", "", r.status === "timed out" ? "No pass from Chief" : "Not sent"), document.createTextNode("Nothing shipped.")); }
  }
  function land(r) {
    const d = r.final?.draft || {}, box = $("land"); box.textContent = "";
    const mail = el("div", "mail");
    const sent = r.sent?.ok && !r.sent?.dry;
    mail.append(el("span", "ok" + (sent ? "" : " dry"), sent ? "✓ Approved by George · sent" : r.sent?.dry ? "Approved · dry run, nothing sent" : r.to ? "Approved" : "Approved · published"));
    mail.append(el("h3", "", d.subject || r.subject || "Follow-up"));
    mail.append(el("div", "to", `To ${r.who ? r.who + " at " : ""}${r.company || ""}`));
    mail.append(el("div", "body", d.body || ""));
    const tm = new Date(r.ended || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    mail.append(el("div", "ft", `v${r.final?.version ?? "?"} · passed Chief · George said yes at ${tm}`));
    box.append(mail); box.classList.add("on");
  }
  $("land").onclick = () => $("land").classList.remove("on");

  // ---------- solo: the task card and the Synth's recent actions ----------
  const hm = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const TASK_STATUS = { approved: "approved, starting", running: "working live", done: "done", failed: "failed" };
  function paintSolo() {
    if (!SOLO) return;
    let box = $("solo");
    if (!box) { box = el("section", "", null); box.id = "solo"; $("grid").append(box); }
    box.textContent = "";
    $("hrun").textContent = ""; $("hrun").append(el("b", "", task?.synthName || soloName));
    if (task) {
      const c = el("div", "task" + (task.status === "failed" ? " bad" : task.status === "done" ? " ok" : ""));
      c.append(el("div", "lbl", "The task"), el("div", "tt", task.task || ""));
      const st = el("div", "tst");
      st.append(el("span", "tag " + (task.status === "done" ? "go" : task.status === "failed" ? "bad" : "real"), TASK_STATUS[task.status] || task.status || ""));
      if (task.approved?.at) st.append(el("span", "", `Approved by ${task.approved.by || "George"} at ${hm(task.approved.at)}`));
      if (task.started) st.append(el("span", "", `started ${hm(task.started)}`));
      if (task.ended) st.append(el("span", "", `ended ${hm(task.ended)}`));
      c.append(st);
      if (task.status === "failed" && task.error) c.append(el("div", "err", task.error));
      if (task.status === "done" || task.status === "failed") { const a = el("a", "btn", task.status === "done" ? "See the proof" : "See what happened"); a.href = "/proof/" + encodeURIComponent(task.taskId || TASK); c.append(a); }
      box.append(c);
    }
    if (log.length) {
      const l = el("div", "log"); l.append(el("div", "lbl", "What it's doing"));
      for (const a of log) { const r = el("div", "li"); r.append(el("time", "", hm(a.at)), document.createTextNode(a.text)); l.append(r); }
      box.append(l);
    }
  }
  async function pollTask() {
    if (!TASK) return;
    try { const t = await fetch("/api/proof/" + encodeURIComponent(TASK), { cache: "no-store" }).then(r => (r.ok ? r.json() : null)); if (t && t.taskId) { task = t; paintSolo(); paintHead(soloName); } } catch {}
    setTimeout(pollTask, task && (task.status === "done" || task.status === "failed") ? 15000 : 3000);
  }

  // ---------- streams ----------
  function onTile(t) { if (!t?.name) return; const had = !!tiles[t.name]; tiles[t.name] = t; if (busyTile(t)) setAct(t.name, t.detail, 0); if (!had || !views[t.name]) layout(); paintHead(t.name); }
  const live = $("live"), livet = $("livet");
  let evOk = false, frOpen = false;
  const sampleOn = () => Object.values(frames).some(f => f.sample);
  const showLive = () => {
    const room = (evOk && helloSeen) || Date.now() - stateAt < 10000;
    const frOk = (frOpen && sseAt) || Date.now() - frPolled < 5000 || Object.values(frames).some(f => Date.now() - f.got < 30000);
    live.classList.toggle("on", room && frOk);
    livet.textContent = room && frOk ? (sampleOn() ? "room live · sample frames" : "live") : room ? "room live · browsers connecting" : frOk ? "browsers live · room connecting" : "connecting";
  };
  const ev = new EventSource("/events");
  ev.onopen = () => { evOk = true; showLive(); }; ev.onerror = () => { evOk = false; showLive(); };
  ev.addEventListener("hello", e => { try { helloSeen = true; const s = JSON.parse(e.data); tiles = s.tiles || {}; layout(); for (const w of Object.keys(views)) paintAll(w); if (s.run) onRun(s.run, true); } catch {} });
  ev.addEventListener("tile", e => { try { onTile(JSON.parse(e.data)); } catch {} });
  ev.addEventListener("line", e => { try { onLine(JSON.parse(e.data)); } catch {} });
  ev.addEventListener("run", e => { try { onRun(JSON.parse(e.data)); } catch {} });
  ev.addEventListener("card", e => { try { const c = JSON.parse(e.data); if (run && c.runId === run.id) { run.status = "awaiting approval"; run.final = c; onRun(run); } } catch {} });
  const fs = new EventSource(q.get("sample") === "1" ? "/frames-sample" : "/frames");
  fs.onopen = () => { frOpen = true; showLive(); }; fs.onerror = () => { frOpen = false; showLive(); };
  let sseAt = 0;   // last byte of frames that came over SSE
  fs.addEventListener("frame", e => { sseAt = Date.now(); try { onFrame(JSON.parse(e.data)); } catch {} });
  fs.addEventListener("mark", e => { sseAt = Date.now(); try { onMark(JSON.parse(e.data)); } catch {} });

  // Some tunnels never pass SSE (Cloudflare quick tunnels hold the stream). If no frame arrives over SSE within 3 s, poll
  // /frames/poll?since=<server ms> → {now, frames:[latest per worker], marks:[...]} every ~350 ms instead. When SSE
  // delivers again, polling stops. It backs off on errors, and to 5 s while the endpoint isn't there yet (404).
  let since = 0, polling = false;
  async function pollFrames() {
    if (sseAt && Date.now() - sseAt < 3000) { polling = false; return; }
    polling = true;
    let wait = 350;
    try {
      const r = await fetch(`/frames/poll?since=${since}`, { cache: "no-store" });
      if (r.status === 404) wait = 5000;
      else if (!r.ok) wait = 1000;
      else {
        const j = await r.json();
        for (const f of j.frames || []) onFrame(f);
        for (const m of j.marks || []) onMark(m);
        if (typeof j.now === "number") since = j.now;
        frPolled = Date.now();
      }
    } catch { wait = 1000; }
    setTimeout(pollFrames, wait);
  }
  let frPolled = 0;
  if (q.get("sample") !== "1") setTimeout(() => { if (!sseAt) pollFrames(); }, 3000);
  setInterval(() => { if (!polling && q.get("sample") !== "1" && (!sseAt || Date.now() - sseAt > 20000)) pollFrames(); }, 5000);

  // /state is the same snapshot as "hello". It fills the wall at once, and if /events stays silent (a proxy that holds the
  // stream) it keeps the room and the run moving by polling every 4 s.
  let helloSeen = false, stateAt = 0, polled = false;
  async function pullState() {
    try {
      const s = await fetch("/state", { cache: "no-store" }).then(r => (r.ok ? r.json() : null));
      if (!s) return;
      stateAt = Date.now();
      if (s.tiles) { for (const t of Object.values(s.tiles)) if (t?.name) tiles[t.name] = { ...tiles[t.name], ...t }; layout(); for (const w of Object.keys(views)) paintHead(w); }
      if (s.run && !SOLO && (!helloSeen || !run)) {
        const fresh = !run || run.id !== s.run.id;
        if (!fresh && Array.isArray(s.run.lines) && s.run.lines.length !== lines.length) { lines = []; for (const l of s.run.lines) onLine({ runId: s.run.id, ...l }, true); renderRoom(); }
        const { lines: _l, ...rest } = s.run;
        onRun(fresh ? s.run : rest, !polled);
      }
      polled = true;
    } catch {}
  }
  pullState();
  setInterval(() => { if (!helloSeen || Date.now() - stateAt > 15000) pullState(); }, 2000);
  const clock = () => { $("clock").textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/Los_Angeles" }) + " PT"; };
  setInterval(() => { for (const w of Object.keys(views)) paintLive(w); clock(); showLive(); }, 500);
  clock(); layout(); if (SOLO) { paintSolo(); pollTask(); }
  addEventListener("resize", fit);
})();
