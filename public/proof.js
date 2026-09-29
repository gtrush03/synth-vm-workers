// Proof page for one team task: /proof/<taskId>. Renders exactly what the runner recorded in runs/proof/<taskId>.json
// (served at /api/proof/<taskId>); it invents nothing. proofs[] kinds: step, shot, source, id, number, result; any other
// kind shows as a plain labelled block. Refreshes while the task is still running.
(function () {
  const id = decodeURIComponent(location.pathname.split("/")[2] || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const m = document.getElementById("m"), zoom = document.getElementById("zoom");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const PT = { timeZone: "America/Los_Angeles" };
  const hm = t => new Date(t).toLocaleTimeString("en-US", { ...PT, hour: "numeric", minute: "2-digit" });
  const hms = t => new Date(t).toLocaleTimeString("en-US", { ...PT, hour: "numeric", minute: "2-digit", second: "2-digit" });
  const safeUrl = u => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const dur = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
  const where = w => (w?.vm && w?.region ? `Vultr · ${w.region} · ${w.vm}` : w?.host ? "this Mac" : null);
  const link = (text, url) => { const a = el("a", "", text); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; };
  zoom.onclick = () => zoom.classList.remove("on");

  function render(t) {
    m.textContent = "";
    const b = el("div", "brand"); const l = el("span"); l.append(el("b", "", "TRU Synth"), document.createTextNode(" · proof")); b.append(l, el("span", "", t.taskId || id)); m.append(b);
    m.append(el("h1", "", t.synthName || t.synth || "Synth"), el("div", "task", t.task || ""));
    if (t.sample || String(t.taskId || id).startsWith("sample-")) m.append(el("span", "sample", "Sample layout · not a real task"));

    const st = t.status || "running", box = el("div", "status " + (st === "done" ? "done" : st === "failed" ? "failed" : "running")), big = el("div", "big");
    if (st === "done") big.textContent = "✓ Done";
    else if (st === "failed") big.textContent = "✗ Failed";
    else { big.append(el("i", "dot"), document.createTextNode(st === "approved" ? "Approved · starting" : "Working live")); }
    box.append(big);
    if (st === "failed" && t.error) box.append(el("div", "err", t.error));
    const dl = el("dl"), row = (k, v) => { if (v) dl.append(el("dt", "", k), el("dd", "", v)); };
    row("Approved", t.approved?.at ? `by ${t.approved.by || "George"} at ${hm(t.approved.at)} PT${t.approved.via ? ` (${t.approved.via === "app" ? "in the app" : t.approved.via === "imessage" ? "by iMessage" : t.approved.via})` : ""}` : "not recorded");
    row("Ran on", where(t.where));
    row("Model", t.model);
    row("Started", t.started ? `${hms(t.started)} PT` : null);
    row("Ended", t.ended ? `${hms(t.ended)} PT` : null);
    row("Took", t.started && t.ended ? dur(t.ended - t.started) : null);
    box.append(dl);
    if (st !== "done" && st !== "failed" && t.synth) { const a = el("a", "live", "Watch it live"); a.href = `/wall?synth=${encodeURIComponent(t.synth)}&task=${encodeURIComponent(t.taskId || id)}`; box.append(a); }
    m.append(box);

    const P = Array.isArray(t.proofs) ? t.proofs : [], of = k => P.filter(p => p.kind === k);

    const results = of("result");
    if (results.length) {
      m.append(el("h2", "", "Result"));
      for (const { data: r = {} } of results) {
        const c = el("div", "result");
        if (r.title) c.append(el("h3", "", r.title));
        if (Array.isArray(r.lines) && r.lines.length) { const ul = el("ul"); for (const x of r.lines) ul.append(el("li", "", String(x))); c.append(ul); }
        if (Array.isArray(r.rows) && r.rows.length) {
          const cols = [...new Set(r.rows.flatMap(x => Object.keys(x || {})))], wrap = el("div", "scroll"), tb = el("table"), hr = el("tr");
          for (const k of cols) hr.append(el("th", "", k));
          tb.append(hr);
          for (const x of r.rows) {
            const tr = el("tr");
            for (const k of cols) { const v = x?.[k], td = el("td"); safeUrl(v) ? td.append(link(host(v) || v, v)) : (td.textContent = v == null ? "" : String(v)); tr.append(td); }
            tb.append(tr);
          }
          wrap.append(tb); c.append(wrap);
        }
        if (safeUrl(r.url)) { const p = el("div"); p.style.marginTop = "10px"; p.append(link("Open the result", r.url)); c.append(p); }
        if (r.private) { const p = el("div", "", "Private to George: hidden on the public page."); p.style.cssText = "margin-top:10px;color:var(--dim);font-size:13px"; c.append(p); }
        m.append(c);
      }
    }

    const nums = of("number");
    if (nums.length) {
      m.append(el("h2", "", "Numbers"));
      const g = el("div", "nums");
      for (const { data: n = {} } of nums) {
        const c = el("div", "num"), v = el("div", "v", String(n.value ?? "–"));
        if (n.unit) v.append(el("small", "", n.unit));
        c.append(v, el("div", "l", n.label || ""), el("div", "f" + (n.from ? "" : " none"), n.from ? `from ${n.from}` : "source not recorded"));
        g.append(c);
      }
      m.append(g);
    }

    const ids = of("id");
    if (ids.length) {
      m.append(el("h2", "", "Key ids"));
      const box2 = el("div", "ids");
      for (const { data: x = {} } of ids) { const r = el("div"); r.append(el("span", "", x.label || "id"), el("code", "", String(x.value ?? ""))); box2.append(r); }
      m.append(box2);
    }

    const steps = P.filter(p => p.kind === "step" || p.kind === "shot").sort((a, b) => (a.at || 0) - (b.at || 0));
    if (steps.length) {
      m.append(el("h2", "", `Steps · ${steps.length}`));
      const tl = el("div", "steps");
      for (const p of steps) {
        const d = p.data || {}, s = el("div", "step" + (p.kind === "shot" ? " shot" : ""));
        if (p.at) s.append(el("time", "", `${hms(p.at)} PT`));
        const text = p.kind === "shot" ? d.caption || "Screenshot" : d.text;
        if (text) s.append(el("div", "t", text));
        const u = safeUrl(d.url);
        if (u) { const x = el("div", "u"); x.append(link(u.replace(/^https:\/\//, ""), u)); s.append(x); }
        else if (d.url) s.append(el("div", "u", String(d.url)));
        if (p.kind === "shot" && /^[A-Za-z0-9_-]{1,40}\.(jpe?g|png)$/i.test(d.file || "")) {
          const img = el("img"); img.loading = "lazy"; img.alt = d.caption || "screenshot"; img.src = `/proof/${encodeURIComponent(t.taskId || id)}/${d.file}`;
          img.onclick = () => { zoom.textContent = ""; const z = el("img"); z.src = img.src; zoom.append(z); zoom.classList.add("on"); };
          s.append(img);
        }
        tl.append(s);
      }
      m.append(tl);
    }

    const srcs = of("source");
    if (srcs.length) {
      m.append(el("h2", "", `Sources · ${srcs.length}`));
      for (const { data: x = {} } of srcs) {
        const r = el("div", "src"), u = safeUrl(x.url);
        r.append(u ? link(x.title || host(u), u) : el("span", "", x.title || String(x.url || "")));
        if (u) r.append(el("div", "d", host(u)));
        if (x.note) r.append(el("div", "n", x.note));
        m.append(r);
      }
    }

    const known = new Set(["step", "shot", "source", "id", "number", "result"]), rest = P.filter(p => !known.has(p.kind));
    if (rest.length) {
      m.append(el("h2", "", "Also recorded"));
      for (const p of rest) {
        const c = el("div", "other"); c.append(el("b", "", p.kind || "note"));
        const d = p.data;
        if (d && typeof d === "object") for (const [k, v] of Object.entries(d)) { const r = el("div"); r.append(el("span", "", k + ": ")); safeUrl(v) ? r.append(link(v, v)) : r.append(document.createTextNode(typeof v === "object" ? JSON.stringify(v) : String(v))); c.append(r); }
        else c.append(el("div", "", String(d ?? "")));
        m.append(c);
      }
    }

    m.append(el("div", "foot", "Everything on this page was recorded by the Synth while it worked: its steps, screenshots, sources and ids. Times are Pacific."));
  }

  let last = "";
  async function load() {
    let t = null;
    try { const r = await fetch("/api/proof/" + encodeURIComponent(id), { cache: "no-store" }); if (r.ok) t = await r.json(); } catch {}
    if (!t || !t.taskId) {
      m.textContent = ""; m.append(el("div", "empty", id ? "No proof has been recorded for this task yet." : "No task given."));
      setTimeout(load, 5000); return;
    }
    const k = JSON.stringify(t);
    if (k !== last) { last = k; render(t); }
    if (t.status !== "done" && t.status !== "failed") setTimeout(load, 3000);
  }
  load();
})();
