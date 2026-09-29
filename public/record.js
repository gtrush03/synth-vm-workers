// One-tab presenter for the HackerSquad recording: six full-screen scenes. → / space / click = next, ← = back,
// n = small speaker notes (off by default: they'd be in the recording), f = full screen, #3 opens scene 3.
// Results come from /record?results=1: George-approved first, else tonight's test tagged as what it was (never shown as real).
(function () {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const scenes = [...document.querySelectorAll(".scene")];
  const NAMES = ["Problem", "Film", "LIVE", "Results", "Stack", "Code"];
  const CITY = { sjc: "San Jose", lax: "Los Angeles", sea: "Seattle", ord: "Chicago", ewr: "New Jersey", dfw: "Dallas", atl: "Atlanta", mia: "Miami" };
  const hm = t => (t ? new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }) + " PT" : "");
  let cur = -1, filmSeen = false;

  // ---------- scenes ----------
  function go(i) {
    i = Math.max(0, Math.min(scenes.length - 1, i));
    if (i === cur) return;
    const prev = cur; cur = i;
    scenes.forEach((s, k) => s.classList.toggle("on", k === i));
    try { history.replaceState(null, "", "#" + (i + 1)); } catch {}
    if (prev === 1) film.pause();
    if (i === 1) playFilm();
    if (i === 3) pullResults();
    notes();
  }
  const next = () => go(cur + 1), back = () => go(cur - 1);
  addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); next(); }
    else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); back(); }
    else if (e.key === "Home") go(0); else if (e.key === "End") go(scenes.length - 1);
    else if (e.key === "n" || e.key === "N") { $("notes").hidden = !$("notes").hidden; notes(); }
    else if (e.key === "f" || e.key === "F") { document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.().catch(() => {}); }
    else if (/^[1-6]$/.test(e.key)) go(Number(e.key) - 1);
  });
  addEventListener("click", e => { if (!e.target.closest("#notes")) next(); });
  addEventListener("hashchange", () => { const n = Number(location.hash.slice(1)); if (n >= 1 && n <= scenes.length) go(n - 1); });
  // hide the pointer while presenting
  let idle; addEventListener("mousemove", () => { document.body.style.cursor = ""; clearTimeout(idle); idle = setTimeout(() => (document.body.style.cursor = "none"), 2000); });

  function notes() {
    const s = scenes[cur]; if (!s) return;
    $("n-scene").textContent = `S${cur + 1} · ${NAMES[cur]} (${cur + 1}/${scenes.length})`;
    $("n-time").textContent = s.dataset.time || "";
    $("n-say").textContent = s.dataset.say || "";
  }
  const chip = (id, text, ok) => { const c = $(id); c.textContent = text; c.className = ok ? "ok" : ""; };

  // ---------- S2: the film, fully preloaded ----------
  const film = $("film");
  let filmReady = false;
  async function loadFilm() {
    try {
      const r = await fetch("/film.mp4", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      film.src = URL.createObjectURL(blob);
      filmReady = true; $("filmwait").hidden = true;
      chip("n-film", `film ready ✓ (${(blob.size / 1e6).toFixed(1)} MB)`, true);
      if (cur === 1) playFilm();
    } catch (e) {
      chip("n-film", String(e.message) === "404" ? "film: not there yet, retrying" : "film: failed to load, retrying", false);
      setTimeout(loadFilm, 15000);
    }
  }
  function playFilm() {
    if (!filmReady) return;
    if (!filmSeen) { film.currentTime = 0; filmSeen = true; }
    film.muted = false; film.volume = 1;
    film.play().catch(() => chip("n-film", "film ready ✓: press → again to start it with sound", true));
  }
  film.addEventListener("ended", () => chip("n-film", "film ended ✓ (→ for LIVE)", true));

  // ---------- S3: the live wall, warm from the start ----------
  $("wall").src = "/wall";

  // ---------- S4: results: "Approved by George" when he tapped yes, otherwise tonight's test, tagged as what it was ----------
  let lastRes = "";
  const TAG = { george: "Approved by George", rehearsal: "Rehearsal", test: "Test run", dry: "Dry run" };
  function card(id, title, it, big, lines, meta) {
    const c = $(id); c.textContent = ""; c.className = "card " + (!it ? "wait" : it.tier === "george" ? "ok" : "test");
    const h = el("div", "h"); h.append(el("div", "t", title));
    h.append(el("div", "tag" + (it ? "" : " none"), it ? `${TAG[it.tier] || "Test run"}${it.at ? ` · ${hm(it.at)}` : ""}` : "·"));   // same height on every card
    c.append(h, el("div", "v", big));
    const d = el("div", "d"); lines.forEach((l, i) => { if (i) d.append(el("br")); typeof l === "string" ? d.append(document.createTextNode(l)) : d.append(l); }); c.append(d);
    if (meta) c.append(el("div", "m", meta));
  }
  const post = t => String(t || "").replace(/\s+/g, " ").trim();   // the whole post, clamped by CSS, never cut mid-word
  function renderResults(r) {
    const e = r?.email, x = r?.x, v = r?.vm;
    if (e) card("c-email", "Email", e, "✓ Sent", [el("b", "", e.tier === "george" ? `Follow-up to ${e.company || "the other company"}` : `Practice follow-up${e.company ? ` · ${e.company}` : ""}`), e.subject || ""], e.id ? `Delivered by Resend · ${e.id}` : "");
    else card("c-email", "Email", null, "Waiting for the run", ["The follow-up lands here once George says yes on a real run."], "");
    const handle = x?.url ? (/x\.com\/([A-Za-z0-9_]+)/.exec(String(x.url)) || [, "trusynth"])[1] : "trusynth";
    if (x && x.tier === "dry") card("c-x", "X post", x, "Typed, not posted", [el("b", "", "@trusynth"), el("span", "q", post(x.text))], "Dry run: the Post button was never pressed.");
    else if (x) card("c-x", "X post", x, "✓ Posted", [el("b", "", `@${handle}`), el("span", "q", post(x.text))], `x.com/${handle}`);
    else card("c-x", "X post", null, "Waiting for the run", ["The post shows here after George taps Yes on the Social card."], "");
    if (v) {
      const city = CITY[String(v.region || "").toLowerCase()] || v.region || "";
      card("c-vm", "Vultr computer", v, v.live === true ? "✓ Live" : v.live === false ? "Not answering" : "✓ Started",
        [el("b", "", `Vultr · ${city}${v.id ? ` · ${v.id}` : ""}`), v.live === true ? "Its own status page is answering right now." : v.live === false ? "Its status page didn't answer just now." : "Started for tonight's demo."],
        v.deletes ? `Deletes itself at ${String(v.deletes).split(" (")[0]}` : "");
    } else card("c-vm", "Vultr computer", null, "Waiting for the run", ["A demo computer shows here once the Ops task runs."], "");
    const all = [e, x, v], g = all.filter(i => i?.tier === "george").length, t = all.filter(i => i && i.tier !== "george").length;
    chip("n-res", `results: ${g}/3 approved by George${t ? `, ${t} tagged test` : ""}${3 - g - t ? `, ${3 - g - t} waiting` : ""}`, g === 3);
  }
  // ---------- S5: the stack ----------
  const STACK = [
    ["Crusoe", "thinks: every Synth's model runs on it"],
    ["Band", "is the room: no room, no Chief veto"],
    ["Vultr", "gives each Synth its own computer"],
    ["Neo4j", "remembers why: every claim traced"],
    ["OpenRouter", "double-checks: the second opinion"],
    ["Resend", "delivers the email"],
  ];
  let stackKey = "";
  function renderStack(sp) {
    const rows = [...STACK, ...(sp?.brave ? [["Brave Search", `the ${typeof sp.brave === "string" ? sp.brave : "Growth Synth"}'s browser searched it`]] : []), ...(sp?.plaud ? [["Plaud", "hears the conversation"]] : [])];
    const k = JSON.stringify(rows);
    if (k === stackKey) return; stackKey = k;
    const box = $("rows"); box.textContent = "";
    for (const [n, w] of rows) { const r = el("div", "row"); r.append(el("div", "n", n), el("div", "w", w)); box.append(r); }
  }
  async function pullResults() {
    try {
      const r = await fetch("/record?results=1", { cache: "no-store" }).then(x => (x.ok ? x.json() : null));
      if (!r) return;
      const k = JSON.stringify([r.email, r.x, r.vm]);
      if (k !== lastRes) { lastRes = k; renderResults(r); }
      renderStack(r.sponsors);
    } catch {}
  }
  renderResults(null); renderStack(null);
  pullResults(); setInterval(pullResults, 5000);
  // a static export of the stack map, if stack-film dropped one; otherwise the sponsor strip
  fetch("/stack/", { cache: "no-store" }).then(r => {
    if (r.ok) { const f = $("stackmap"); f.src = "/stack/"; f.hidden = false; $("strip").hidden = true; chip("n-stack", "stack: map export ✓", true); }
    else chip("n-stack", "stack: sponsor strip", false);
  }).catch(() => chip("n-stack", "stack: sponsor strip", false));

  // ---------- S6: QR codes ----------
  const qr = (id, text) => { try { new QRCode($(id), { text, width: 512, height: 512, colorDark: "#000000", colorLight: "#f4f2ee", correctLevel: QRCode.CorrectLevel.M }); } catch { $(id).style.display = "none"; } };
  qr("qr-gh", "https://github.com/gtrush03/synth-vm-workers");
  qr("qr-live", "https://live.trusynth.com");

  const start = Number(location.hash.slice(1));
  loadFilm();
  go(start >= 1 && start <= scenes.length ? start - 1 : 0);
})();
