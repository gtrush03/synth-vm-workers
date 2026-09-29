// HTTP for the deal graph view and the Crusoe panel. server.ts calls it first: `const g = await graphRoutes(req); if (g) return g;`
//   /graph, /graph.js                the force graph (tap a claim → its path back to the transcript second or source)
//   /panel, /panel-crusoe.js         per-call Crusoe router table (reads the existing /events SSE)
//   /wall, /wall.js                  every Synth's live browser on the big screen (reads /frames + /events);
//                                    /wall?synth=<id>&task=<taskId> = one Synth, phone-first (the "watch it live" link)
//   /proof/<taskId>, /proof.js       a team task's proof page; /api/proof/<taskId> its JSON; /proof/<taskId>/<n>.jpg its shots
//   /record, /record.js, /record.css the one-tab presenter for the HackerSquad recording; /record?results=1 = its live results
//   /film.mp4                        the edited film (range requests); /stack/*  a static export of the stack map, if one is there
//   /api/graph?run=<id>              the run's nodes + edges (default: the newest REAL run; ?rehearsals=1 includes rehearsals)
//   /api/graph/path?claim=<id|key>   one claim, every version, back to its evidence
//   /api/graph/runs                  newest runs
import { latestRuns, pathFor, runGraph, runKind } from "./index";

const PUB = new URL("../../public/", import.meta.url).pathname;
const FILES: Record<string, [string, string]> = {
  "/graph": ["graph.html", "text/html; charset=utf-8"],
  "/graph.js": ["graph.js", "text/javascript; charset=utf-8"],
  "/panel": ["panel-crusoe.html", "text/html; charset=utf-8"],
  "/panel-crusoe.js": ["panel-crusoe.js", "text/javascript; charset=utf-8"],
  "/wall": ["wall.html", "text/html; charset=utf-8"],
  "/wall.js": ["wall.js", "text/javascript; charset=utf-8"],
  "/proof.js": ["proof.js", "text/javascript; charset=utf-8"],
  "/record.js": ["record.js", "text/javascript; charset=utf-8"],
  "/record.css": ["record.css", "text/css; charset=utf-8"],
};
// Team task proof, written by the task runner: runs/proof/<taskId>.json + runs/proof/<taskId>/<n>.jpg
const PROOF = new URL("../../runs/proof/", import.meta.url).pathname;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/, SHOT = /^[A-Za-z0-9_-]{1,40}\.(jpe?g|png)$/i;
const json = (x: unknown, status = 200) => Response.json(x, { status, headers: { "cache-control": "no-store" } });

// Public host (live.trusynth.com sends `x-public: 1`): no email address anywhere, and no transcript text from runs of kind
// "real": transcript lines and commitments become "(private)" and quoted speech inside claims/decisions becomes “(private)”.
// Fails closed: a path whose run can't be told apart is treated as real. Screenshots of a Synth's own views (synth://, e.g.
// the compose view with the address or the transcript view) are not served publicly.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const QUOTED = /“[^”]{3,}”|"[^"\n]{3,}"|‘[^’]{3,}’|(^|[\s(\[:])'[^'\n]{6,}'(?=[\s).,;:!?\]]|$)/g;
const PRIVATE = "(private)";
function mapStrings<T>(x: T, f: (s: string) => string): T {
  if (typeof x === "string") return f(x) as T;
  if (Array.isArray(x)) return x.map(v => mapStrings(v, f)) as T;
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, mapStrings(v, f)])) as T;
  return x;
}
const noEmails = <T>(x: T) => mapStrings(x, s => s.replace(EMAIL, "(address hidden)"));
const noQuotes = (s: string) => s.replace(QUOTED, (m, pre) => (typeof pre === "string" ? pre : "") + "“" + PRIVATE + "”");
function privateRun<T extends { nodes: any[] }>(g: T): T {
  const nodes = g.nodes.map(n => {
    if (n.label === "TranscriptLine" || n.label === "Commitment" || (n.label === "Source" && n.kind === "transcript"))
      return { ...n, text: PRIVATE, body: n.body == null ? null : PRIVATE, ...(n.label === "Source" ? { title: "Transcript line" } : {}) };
    return mapStrings(n, noQuotes);
  });
  return { ...g, nodes };
}
async function publicGraph<T extends { nodes: any[] }>(g: T, runIds: string[]): Promise<T> {
  const ids = [...new Set(runIds.filter(Boolean))];
  const rehearsalOnly = ids.length > 0 && (await Promise.all(ids.map(runKind))).every(k => k === "rehearsal");
  return noEmails(rehearsalOnly ? g : privateRun(g));
}

// ---------- /record: the presenter's live results: George's approved ones first, else tonight's tests, tagged ----------
const HACK = `${process.env.HOME}/Genie/scratch/hackday-0929`;
const FILM = `${HACK}/video/out/final.mp4`, STACK = `${HACK}/stack-export/`;
const RUNS = new URL("../../runs/", import.meta.url).pathname;
let resultsCache: { at: number; v: unknown } | null = null;
async function recordResults() {
  if (resultsCache && Date.now() - resultsCache.at < 8000) return resultsCache.v;
  const readJson = async (f: string) => { try { return await Bun.file(f).json(); } catch { return null; } };
  // Each card: George's own approved result first; otherwise tonight's latest real-world test, tagged as what it was
  // (a rehearsal send, a test-approved VM, a dry-run post). A rehearsal is never shown as real; a dry run never as posted.
  const TONIGHT = Date.now() - 18 * 3.6e6;
  // Deal Room email: a run that really sent (never a dry run): kind real first, else a rehearsal that really sent tonight
  const runs: any[] = (await readJson(`${RUNS}state.json`)) ?? [];
  const sentRuns = [...runs].reverse().filter(r => r.status === "shipped" && r.sent?.ok && !r.sent?.dry && !r.dry);
  const r = sentRuns.find(r => r.kind === "real") ?? sentRuns.find(r => r.kind !== "real" && (r.sent?.at ?? r.ended ?? r.started ?? 0) > TONIGHT);
  // the subject only when it can't carry the contact's name (no name known = no subject); company + subject, no address, no name
  const names = String(r?.who ?? "").split(/[^\p{L}'-]+/u).filter(w => w.length > 1).map(w => w.toLowerCase());
  const subj = String(r?.final?.draft?.subject ?? r?.subject ?? "");
  const subject = subj && names.length && !names.some(n => subj.toLowerCase().includes(n)) ? subj : null;
  const email = r ? { tier: r.kind === "real" ? "george" : "rehearsal", company: r.company ?? null, subject, at: r.sent?.at ?? r.ended ?? r.started ?? null, id: String(r.sent?.id ?? "").slice(0, 8) || null } : null;
  // TEAM proofs: "george" only for George's own tap (a test approval never counts as his)
  const files = [...new Bun.Glob("*.json").scanSync(PROOF)].filter(f => !f.startsWith("sample-"));
  const tasks = (await Promise.all(files.map(f => readJson(PROOF + f)))).filter(Boolean) as any[];
  const done = (synth: string) => tasks.filter(t => t.synth === synth && t.status === "done").sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0));
  const idOf = (t: any, label: string) => t?.proofs?.find((p: any) => p.kind === "id" && p.data?.label === label)?.data?.value;
  const resultOf = (t: any) => t?.proofs?.find((p: any) => p.kind === "result")?.data;
  const byGeorge = (t: any) => t.approved?.by === "George";
  const pick = (ts: any[]) => ts.find(byGeorge) ?? ts.find(t => (t.ended ?? 0) > TONIGHT);
  // X: a real post (URL recorded); else tonight's dry run, which typed the post and never pressed Post
  const socials = done("social");
  const s = pick(socials.filter(t => /^https:\/\/(x|twitter)\.com\//.test(String(idOf(t, "X post") ?? ""))));
  const d = s ? null : socials.find(t => (t.ended ?? 0) > TONIGHT && /dry run/i.test(resultOf(t)?.title ?? ""));
  const x = s ? { tier: byGeorge(s) ? "george" : "test", url: idOf(s, "X post"), at: s.ended ?? null, text: resultOf(s)?.lines?.[0] ?? null }
    : d ? { tier: "dry", url: null, at: d.ended ?? null, text: resultOf(d)?.lines?.[0] ?? null } : null;
  const o = pick(done("ops").filter(t => idOf(t, "Vultr instance"))), vmId = idOf(o, "Vultr instance");
  let vm: any = null;
  if (o && vmId) {
    const srcs = (o.proofs ?? []).filter((p: any) => p.kind === "source");
    const page = (srcs.find((p: any) => /status page/i.test(p.data?.title ?? "")) ?? srcs[0])?.data?.url;
    let live: boolean | null = null;
    if (page) live = await fetch(page, { signal: AbortSignal.timeout(3000) }).then(r => r.ok).catch(() => false);
    vm = { tier: byGeorge(o) ? "george" : "test", id: String(vmId).slice(0, 8), region: String(idOf(o, "Region") ?? "").replace(/\s*\(.*\)/, "") || null, deletes: idOf(o, "Deletes at") ?? null, at: o.ended ?? null, live, checked: Date.now() };
  }
  // sponsors only when they really worked tonight: Brave = a done task that browsed search.brave.com; Plaud = a real run from a Plaud recording
  // (brave = the name of the Synth whose browser searched it: no API is claimed)
  const braveBy = tasks.filter(t => t.status === "done" && (t.ended ?? 0) > TONIGHT).find(t => (t.proofs ?? []).some((p: any) => /^https:\/\/search\.brave\.com\//.test(String(p.data?.url ?? ""))));
  const brave = braveBy ? String(braveBy.synthName ?? "a Synth") : false;
  const plaud = runs.some(r => r.kind === "real" && (r.lines ?? []).some((l: any) => /Plaud/.test(l.text ?? "") && !/practice/i.test(l.text ?? "")));
  const v = noEmails({ email, x, vm, sponsors: { brave, plaud }, at: Date.now() });
  resultsCache = { at: Date.now(), v };
  return v;
}
async function rangeFile(req: Request, path: string, type: string): Promise<Response> {
  const f = Bun.file(path);
  if (!(await f.exists())) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const size = f.size, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache", "last-modified": new Date(f.lastModified).toUTCString() };
  if (!m || (!m[1] && !m[2])) return new Response(f, { headers: { ...base, "content-length": String(size) } });
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  return new Response(f.slice(start, end + 1), { status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
}

export async function graphRoutes(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const u = new URL(req.url), p = u.pathname, pub = req.headers.get("x-public") === "1";
  const f = FILES[p];
  if (f) return new Response(Bun.file(PUB + f[0]), { headers: { "content-type": f[1], "cache-control": "no-store" } });
  if (p === "/record") {
    if (u.searchParams.get("results") === "1") return json(await recordResults());
    return new Response(Bun.file(PUB + "record.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (p === "/film.mp4") return rangeFile(req, FILM, "video/mp4");
  if (p === "/stack") return new Response(null, { status: 301, headers: { location: "/stack/" } });   // so the export's relative paths resolve
  if (p.startsWith("/stack/")) {
    const rel = p === "/stack/" ? "index.html" : decodeURIComponent(p.slice(7));
    if (!/^[A-Za-z0-9_.\/-]{1,120}$/.test(rel) || rel.includes("..")) return new Response("Not found", { status: 404 });
    const f = Bun.file(STACK + rel);
    if (!(await f.exists())) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(f, { headers: { "cache-control": "no-cache" } });
  }
  const pm = p.match(/^\/(api\/)?proof\/([^/]+)(?:\/([^/]+))?$/);
  if (pm && TASK_ID.test(pm[2] ?? "")) {
    const api = pm[1], id = pm[2]!, file = pm[3];
    const task = async () => { const f = Bun.file(`${PROOF}${id}.json`); return (await f.exists()) ? await f.json().catch(() => null) : null; };
    if (api && !file) {
      if (!pub) {
        const f = Bun.file(`${PROOF}${id}.json`);
        return (await f.exists()) ? new Response(f, { headers: { "content-type": "application/json", "cache-control": "no-store" } }) : json({ error: "no proof recorded yet" }, 404);
      }
      const t = await task();
      if (!t) return json({ error: "no proof recorded yet" }, 404);
      // own-view screenshots stay off the public host (they can show an address or the transcript)
      if (Array.isArray(t.proofs)) t.proofs = t.proofs.map((x: any) => x?.kind === "shot" && !/^https:\/\//i.test(x?.data?.url ?? "")
        ? { ...x, data: { ...x.data, file: null, caption: `${x.data?.caption ?? "Screenshot"} (own view, not shown publicly)` } }
        // an entry the Synth marked private (e.g. George's promises) keeps its shape and title, every other word is hidden
        : x?.data?.private ? { ...x, data: { ...mapStrings(x.data, () => PRIVATE), title: x.data.title ?? null, private: true } } : x);
      return json(noEmails(t));
    }
    if (!api && !file) return new Response(Bun.file(PUB + "proof.html"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (!api && file && SHOT.test(file)) {
      if (pub) {
        const t = await task(), shot = (t?.proofs ?? []).find((x: any) => x?.kind === "shot" && x?.data?.file === file);
        if (!shot || !/^https:\/\//i.test(shot.data?.url ?? "")) return new Response("Not found", { status: 404 });
      }
      const f = Bun.file(`${PROOF}${id}/${file}`);
      if (await f.exists()) return new Response(f, { headers: { "content-type": /png$/i.test(file) ? "image/png" : "image/jpeg", "cache-control": "public, max-age=3600" } });
    }
    return new Response("Not found", { status: 404 });
  }
  // rehearsal runs are hidden unless ?rehearsals=1 (a run opened by id is always shown, labelled with its kind)
  const reh = u.searchParams.get("rehearsals") === "1";
  if (p === "/api/graph/runs") { const r = (await latestRuns(15, { rehearsals: reh })).filter(r => !r.id.startsWith("test-")); return json(pub ? noEmails(r) : r); }
  if (p === "/api/graph/path") {
    const claim = (u.searchParams.get("claim") ?? "").slice(0, 200);
    if (!claim) return json({ nodes: [], edges: [] });
    const g = await pathFor(claim);
    return json(pub ? await publicGraph(g, [...g.nodes.map((n: any) => n.runId), claim.includes(":") ? claim.split(":")[0]! : ""]) : g);
  }
  if (p === "/api/graph") {
    let run = (u.searchParams.get("run") ?? "").slice(0, 80);
    if (!run) run = (await latestRuns(15, { rehearsals: reh })).find(r => !r.id.startsWith("test-"))?.id ?? "";
    if (!run) return json({ run: "", kind: null, nodes: [], edges: [] });
    const g = { ...(await runGraph(run)), kind: await runKind(run) };
    return json(pub ? await publicGraph(g, [run]) : g);
  }
  return null;
}
