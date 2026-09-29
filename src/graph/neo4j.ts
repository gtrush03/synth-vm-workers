// The deal graph on Neo4j Aura, spoken over the HTTPS Query API (POST /db/<db>/query/v2), so no driver dependency.
// Credentials: NEO4J_JSON env (on a VM) or the macOS Keychain item "hackday-neo4j" ({uri, user, password, instance_id}).
// The database name is the Aura instance id, not "neo4j". Keys stay in memory only: never logged or written.
//
// Schema (every node carries runId; keys are run-scoped so two runs never collide):
//   (:Run {id, company})
//   (:TranscriptLine {key, id, speaker, t, tSec, text})   <-[:SAID]-(:Person {name})-[:WORKS_AT]->(:Company {name})
//   (:Source {key, id, kind: web|sender|brave|similarweb, title, url, text})
//   (:Claim {key, id, version, text, by})  -[:CITES]->(Source|TranscriptLine)   -[:REVISES]->(:Claim previous version)
//   (:Commitment {key, id, text, owner, due})  -[:FROM_LINE]->(:TranscriptLine)   -[:MADE_BY]->(:Person)
//   (:Decision {key, verdict, by, reason, at})  -[:ON]->(:Claim|:Commitment)
//   every node -[:IN_RUN]->(:Run)
import type { ClaimIn, DecisionIn, GEdge, GNode, Graph, SourceIn } from "./index";

type Cfg = { url: string; auth: string };
let cfgP: Promise<Cfg | null> | null = null;

async function keychain(service: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 && out ? out : undefined;
}

function config(): Promise<Cfg | null> {
  return (cfgP ??= (async () => {
    const raw = process.env.NEO4J_JSON ?? (await keychain("hackday-neo4j"));
    if (!raw) return null;
    const j = JSON.parse(raw);
    const host = String(j.uri ?? "").split("://").pop()!.replace(/[/:].*$/, "");
    const db = process.env.NEO4J_DATABASE ?? j.instance_id ?? j.instance ?? j.database;
    if (!host || !db || !j.user || !j.password) return null;
    return { url: `https://${host}/db/${encodeURIComponent(db)}/query/v2`, auth: "Basic " + btoa(`${j.user}:${j.password}`) };
  })());
}

export async function configured(): Promise<boolean> { return !!(await config().catch(() => null)); }

// One Cypher statement → rows as plain objects. Throws on HTTP or Cypher errors (the facade in index.ts catches).
export async function cypher<T = Record<string, any>>(statement: string, parameters: Record<string, unknown> = {}): Promise<T[]> {
  const c = await config();
  if (!c) throw new Error("neo4j not configured");
  const r = await fetch(c.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: c.auth },
    body: JSON.stringify({ statement, parameters }),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error(`neo4j ${r.status}: ${j.errors?.[0]?.code ?? ""} ${String(j.errors?.[0]?.message ?? "").slice(0, 160)}`);
  const fields: string[] = j.data?.fields ?? [];
  return (j.data?.values ?? []).map((row: unknown[]) => Object.fromEntries(fields.map((f, i) => [f, row[i]])) as T);
}

let schemaP: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  return (schemaP ??= (async () => {
    const uniq: [string, string][] = [["Run", "id"], ["Claim", "key"], ["Source", "key"], ["TranscriptLine", "key"], ["Decision", "key"], ["Commitment", "key"], ["Person", "name"], ["Company", "name"]];
    await Promise.all(uniq.map(([l, p]) => cypher(`CREATE CONSTRAINT ${l.toLowerCase()}_${p} IF NOT EXISTS FOR (n:${l}) REQUIRE n.${p} IS UNIQUE`).catch(() => {})));
    await cypher("CREATE INDEX claim_run IF NOT EXISTS FOR (n:Claim) ON (n.runId, n.id)").catch(() => {});
  })());
}

const key = (runId: string, id: string) => `${runId}:${id}`;
// "0:12" / "1:05" / 12 → seconds, for sorting and for the "said at 0:12" label
const toSec = (t: unknown): number | null => {
  if (typeof t === "number" && isFinite(t)) return t;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$|^(\d+(?:\.\d+)?)s?$/.exec(String(t ?? "").trim());
  if (!m) return null;
  return m[4] !== undefined ? Number(m[4]) : Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};

// kind: "real" only for runs started from George's own texts or recordings; everything else (dry runs, test
// transcripts, rehearsals) is "rehearsal". A run with no kind counts as a rehearsal everywhere.
export type RunKind = "real" | "rehearsal";
export async function recordRun(runId: string, info: { company?: string; title?: string; kind?: RunKind } = {}) {
  await ensureSchema();
  await cypher("MERGE (r:Run {id:$runId}) ON CREATE SET r.at = timestamp() SET r.company = coalesce($company, r.company), r.title = coalesce($title, r.title), r.kind = coalesce($kind, r.kind)",
    { runId, company: info.company ?? null, title: info.title ?? null, kind: info.kind === "real" || info.kind === "rehearsal" ? info.kind : null });
}
export async function setRunKind(runId: string, kind: RunKind) {
  if (kind !== "real" && kind !== "rehearsal") throw new Error("kind must be real or rehearsal");
  await cypher("MERGE (r:Run {id:$runId}) ON CREATE SET r.at = timestamp() SET r.kind = $kind", { runId, kind });
}
export async function runKind(runId: string): Promise<RunKind> {
  const r = await cypher<{ k: string | null }>("MATCH (r:Run {id:$runId}) RETURN r.kind AS k", { runId });
  return r[0]?.k === "real" ? "real" : "rehearsal";
}

export async function recordSource(s: SourceIn) {
  await ensureSchema();
  const p = { runId: s.runId, key: key(s.runId, s.id), id: s.id, kind: s.kind, title: s.title ?? "", url: s.url ?? null, text: String(s.text ?? "").slice(0, 2000),
    speaker: s.speaker ?? null, t: s.t == null ? null : String(s.t), tSec: toSec(s.t) };
  if (s.kind === "transcript") {
    await cypher(`MERGE (r:Run {id:$runId}) ON CREATE SET r.at = timestamp()
      MERGE (l:TranscriptLine {key:$key}) SET l.runId=$runId, l.id=$id, l.title=$title, l.text=$text, l.speaker=$speaker, l.t=$t, l.tSec=$tSec, l.at=timestamp()
      MERGE (l)-[:IN_RUN]->(r)
      WITH l FOREACH (_ IN CASE WHEN $speaker IS NULL THEN [] ELSE [1] END | MERGE (p:Person {name:$speaker}) MERGE (p)-[:SAID]->(l))`, p);
  } else {
    await cypher(`MERGE (r:Run {id:$runId}) ON CREATE SET r.at = timestamp()
      MERGE (s:Source {key:$key}) SET s.runId=$runId, s.id=$id, s.kind=$kind, s.title=$title, s.url=$url, s.text=$text, s.at=timestamp()
      MERGE (s)-[:IN_RUN]->(r)`, p);
  }
}

export async function recordTranscript(runId: string, lines: { id?: string; speaker: string; t: number | string; text: string }[]) {
  const ids: string[] = [];
  for (const [i, l] of lines.entries()) {
    const id = l.id ?? `L${i + 1}`;
    await recordSource({ runId, id, kind: "transcript", title: `${l.speaker} at ${l.t}`, speaker: l.speaker, t: l.t, text: l.text });
    ids.push(id);
  }
  return ids;
}

export async function recordParty(runId: string, x: { person: string; company?: string }) {
  await ensureSchema();
  await cypher(`MERGE (p:Person {name:$person}) WITH p
    FOREACH (_ IN CASE WHEN $company IS NULL THEN [] ELSE [1] END | MERGE (c:Company {name:$company}) MERGE (p)-[:WORKS_AT]->(c))
    WITH p MATCH (r:Run {id:$runId}) MERGE (p)-[:IN_RUN]->(r)`, { runId, person: x.person, company: x.company ?? null });
}

export async function recordCommitment(runId: string, c: { id: string; text: string; owner?: string; due?: string; lineId?: string }) {
  await ensureSchema();
  await cypher(`MERGE (r:Run {id:$runId}) ON CREATE SET r.at = timestamp()
    MERGE (c:Commitment {key:$key}) SET c.runId=$runId, c.id=$id, c.text=$text, c.owner=$owner, c.due=$due, c.at=timestamp()
    MERGE (c)-[:IN_RUN]->(r)
    WITH c OPTIONAL MATCH (l:TranscriptLine {key:$lineKey}) FOREACH (_ IN CASE WHEN l IS NULL THEN [] ELSE [1] END | MERGE (c)-[:FROM_LINE]->(l))
    WITH c FOREACH (_ IN CASE WHEN $owner IS NULL THEN [] ELSE [1] END | MERGE (p:Person {name:$owner}) MERGE (c)-[:MADE_BY]->(p))`,
    { runId, key: key(runId, c.id), id: c.id, text: c.text, owner: c.owner ?? null, due: c.due ?? null, lineKey: c.lineId ? key(runId, c.lineId) : null });
}

export async function recordClaim(c: ClaimIn) {
  await ensureSchema();
  const version = Number(c.version) || 1;
  await cypher(`MERGE (r:Run {id:$runId}) ON CREATE SET r.at = timestamp()
    MERGE (c:Claim {key:$key}) SET c.runId=$runId, c.id=$id, c.version=$version, c.text=$text, c.by=$by, c.at=timestamp()
    MERGE (c)-[:IN_RUN]->(r)
    WITH c OPTIONAL MATCH (prev:Claim {runId:$runId, id:$id}) WHERE prev.version < $version
    WITH c, prev ORDER BY prev.version DESC LIMIT 1
    FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | MERGE (c)-[:REVISES]->(prev))
    WITH c UNWIND (CASE WHEN size($srcKeys) = 0 THEN [null] ELSE $srcKeys END) AS sk
    OPTIONAL MATCH (s:Source {key:sk}) OPTIONAL MATCH (l:TranscriptLine {key:sk})
    WITH c, coalesce(s, l) AS src FOREACH (_ IN CASE WHEN src IS NULL THEN [] ELSE [1] END | MERGE (c)-[:CITES]->(src))`,
    { runId: c.runId, key: `${key(c.runId, c.id)}:v${version}`, id: c.id, version, text: String(c.text ?? "").slice(0, 1000), by: c.by,
      srcKeys: (c.sourceIds ?? []).map(s => key(c.runId, String(s))) });
}

// Link helpers for callers that learn the evidence after the claim was recorded (latest version of the claim).
async function linkTo(claimId: string, label: "Source" | "TranscriptLine", runId: string, srcId: string) {
  await cypher(`MATCH (c:Claim) WHERE c.key = $claimId OR (c.runId = $runId AND c.id = $claimId)
    WITH c ORDER BY c.version DESC LIMIT 1 MATCH (s:${label} {key:$sk}) MERGE (c)-[:CITES]->(s)`, { claimId, runId, sk: key(runId, srcId) });
}
export const linkSource = (runId: string, claimId: string, sourceId: string) => linkTo(claimId, "Source", runId, sourceId);
export const linkTranscript = (runId: string, claimId: string, lineId: string) => linkTo(claimId, "TranscriptLine", runId, lineId);

export async function recordDecision(d: DecisionIn) {
  await ensureSchema();
  await cypher(`MERGE (r:Run {id:$runId}) ON CREATE SET r.at = timestamp()
    CREATE (d:Decision {key:$key, runId:$runId, verdict:$verdict, by:$by, reason:$reason, claimId:$claimId, at:timestamp()})
    MERGE (d)-[:IN_RUN]->(r)
    WITH d OPTIONAL MATCH (c:Claim) WHERE $claimId IS NOT NULL AND (c.key = $claimId OR (c.runId = $runId AND c.id = $claimId))
    WITH d, c ORDER BY c.version DESC LIMIT 1
    FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END | MERGE (d)-[:ON]->(c))`,
    { runId: d.runId, key: `${d.runId}:d:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, verdict: d.verdict, by: d.by,
      reason: String(d.reason ?? "").slice(0, 500), claimId: d.claimId ?? null });
}

// Claims (latest version of each) that cite nothing: no source and no transcript line. Chief vetoes these.
export async function unsupportedClaims(runId: string): Promise<{ id: string; version: number; text: string; by: string }[]> {
  return cypher(`MATCH (c:Claim {runId:$runId}) WITH c.id AS id, max(c.version) AS v
    MATCH (c:Claim {runId:$runId, id:id, version:v}) WHERE NOT (c)-[:CITES]->()
    RETURN c.id AS id, c.version AS version, c.text AS text, c.by AS by ORDER BY c.at`, { runId });
}

// ---------- read side: shapes for the graph view ----------
const nodeOf = (m: any): GNode => {
  const label = m.label as string;
  const text = label === "TranscriptLine" ? `${m.speaker ?? "?"} · ${m.t ?? ""}: ${m.text ?? ""}` : label === "Decision" ? `${m.verdict} by ${m.by}: ${m.reason ?? ""}`
    : label === "Source" ? (m.title || m.url || m.id) : label === "Run" ? (m.company ?? m.id) : label === "Person" || label === "Company" ? m.name : (m.text ?? m.id);
  return { ...m, id: m.gid, rawId: m.id ?? null, label, text: String(text ?? ""), body: m.text ?? null };
};
const RET = (v: string) => `${v}{.*, gid: coalesce(${v}.key, ${v}.id, ${v}.name), label: head([l IN labels(${v}) WHERE l <> 'Resource'])}`;

// One claim, every version of it (the REVISES chain), back to the evidence: sources / transcript lines (and who said
// them), and the decisions on each version. Built from the run graph so it sees the same repaired links.
export async function pathFor(claimId: string): Promise<Graph> {
  const hit = (await cypher<{ run: string; key: string }>(`MATCH (c:Claim) WHERE c.key = $claimId OR c.id = $claimId
    RETURN c.runId AS run, c.key AS key ORDER BY c.at DESC LIMIT 1`, { claimId }))[0];
  if (!hit) return { nodes: [], edges: [] };
  const g = await runGraph(hit.run);
  const keep = new Set([hit.key]);
  for (let grew = true; grew;) {   // follow REVISES both ways
    grew = false;
    for (const e of g.edges) if (e.type === "REVISES" && (keep.has(e.from) !== keep.has(e.to))) { keep.add(e.from); keep.add(e.to); grew = true; }
  }
  const ids = new Set(keep), edges: GEdge[] = [];
  for (const e of g.edges) {
    if ((e.type === "CITES" || e.type === "REVISES") && keep.has(e.from)) { edges.push(e); ids.add(e.to); }
    if (e.type === "ON" && keep.has(e.to)) { edges.push(e); ids.add(e.from); }
  }
  for (const e of g.edges) if (e.type === "SAID" && ids.has(e.to)) { edges.push(e); ids.add(e.from); }
  return { nodes: g.nodes.filter(n => ids.has(n.id)), edges };
}

// The whole run, for the force graph.
export async function runGraph(runId: string): Promise<Graph & { run: string }> {
  const rows = await cypher(`MATCH (r:Run {id:$runId})<-[:IN_RUN]-(n) WHERE NOT n:Person
    OPTIONAL MATCH (n)-[e:CITES|REVISES|ON|FROM_LINE|MADE_BY]->(m)
    RETURN ${RET("n")} AS n, collect(DISTINCT CASE WHEN m IS NULL THEN null ELSE [type(e), coalesce(m.key, m.id, m.name)] END) AS out`, { runId });
  const people = await cypher(`MATCH (p:Person)-[:SAID]->(l:TranscriptLine {runId:$runId}) RETURN ${RET("p")} AS p, collect(l.key) AS lines`, { runId });
  const nodes = new Map<string, GNode>(), edges: GEdge[] = [];
  for (const r of rows) { nodes.set(r.n.gid, nodeOf(r.n)); for (const o of r.out) if (o) edges.push({ from: r.n.gid, to: o[1], type: o[0] }); }
  for (const r of people) { nodes.set(r.p.gid, nodeOf(r.p)); for (const l of r.lines) edges.push({ from: r.p.gid, to: l, type: "SAID" }); }
  const all = [...nodes.values()];
  return { run: runId, nodes: all, edges: repair(all, dedupe(edges)).filter(e => nodes.has(e.from) && nodes.has(e.to)) };
}

export async function latestRuns(limit = 10, opts: { rehearsals?: boolean } = {}): Promise<{ id: string; company: string | null; at: number; claims: number; kind: RunKind }[]> {
  const rows = await cypher<any>(`MATCH (r:Run) WHERE $reh OR r.kind = 'real' OPTIONAL MATCH (c:Claim)-[:IN_RUN]->(r)
    RETURN r.id AS id, r.company AS company, r.at AS at, count(c) AS claims, r.kind AS kind ORDER BY r.at DESC LIMIT $limit`, { limit, reh: opts.rehearsals ?? true });
  return rows.map(r => ({ ...r, kind: r.kind === "real" ? "real" : "rehearsal" }));
}

// Test helper: remove one run's nodes (only ever used on runs the test itself created).
export async function deleteRun(runId: string) {
  await cypher("MATCH (n {runId:$runId}) DETACH DELETE n", { runId });
  await cypher("MATCH (r:Run {id:$runId}) DETACH DELETE r", { runId });
}

// Read-time repair, so the picture stays true when writers race or number claims per draft:
// - REVISES links a version to the most similar claim of the version before (word overlap ≥ 0.3; same id breaks ties),
//   not blindly to the same id, because a writer that numbers claims per draft reuses "c1" for a different claim.
// - A decision with no ON edge (it was written before its claim, or carried no claimId) is attached to the claim
//   version current at its time; a VETO/CORRECTED without a claimId is matched by the claim text quoted in its reason.
const words = (s: unknown) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2));
// share of the shorter text's words found in the other ("send a short write-up" vs "I will send the write-up tonight")
function contained(a: unknown, b: unknown) {
  const A = words(a), B = words(b); let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return Math.min(A.size, B.size) < 2 ? 0 : i / Math.min(A.size, B.size);
}
function overlap(a: unknown, b: unknown) {
  const A = words(a), B = words(b); let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return i / Math.max(1, A.size + B.size - i);
}
function repair(nodes: GNode[], edges: GEdge[]): GEdge[] {
  const claims = nodes.filter(n => n.label === "Claim"), ver = (n: GNode) => Number(n.version) || 1, at = (n: GNode) => Number(n.at) || 0;
  let out = edges.filter(e => e.type !== "REVISES");
  // a stored ON edge was chosen at write time ("newest version so far"); if the reason clearly describes another
  // version with the same id (written a moment later), move the edge there
  const byId = new Map(nodes.map(n => [n.id, n]));
  out = out.map(e => {
    const d = byId.get(e.from), cur = byId.get(e.to);
    if (e.type !== "ON" || !d?.claimId || !cur) return e;
    let best = cur, bs = overlap(d.reason, cur.body);
    const base = bs;
    for (const c of claims) if (c.rawId === d.claimId && c.id !== cur.id) { const s = overlap(d.reason, c.body); if (s > bs) { bs = s; best = c; } }
    return best !== cur && bs >= 0.12 && bs > base + 0.05 ? { ...e, to: best.id } : e;
  });
  const attached = new Set(out.filter(e => e.type === "ON").map(e => e.from));
  for (const d of nodes) {
    if (d.label !== "Decision" || attached.has(d.id)) continue;
    const reason = String(d.reason ?? "").toLowerCase();
    const cands = (d.claimId ? claims.filter(c => c.rawId === d.claimId)
      : /VETO|CORRECTED/.test(String(d.verdict)) ? claims.filter(c => String(c.body ?? "").length > 8 && reason.includes(String(c.body).toLowerCase().slice(0, 80))) : [])
      .sort((a, b) => ver(b) - ver(a));
    // the version the reason talks about wins (writers that number claims per draft reuse ids); else the one current then
    let t: GNode | undefined, ts = 0;
    for (const c of cands) { const s = overlap(d.reason, c.body); if (s > ts) { ts = s; t = c; } }
    if (!t || ts < 0.12) t = cands.find(c => at(c) <= at(d) + 3000) ?? cands[cands.length - 1];
    if (t) out.push({ from: d.id, to: t.id, type: "ON" });
  }
  const verdictOn = new Map<string, string[]>();
  for (const e of out) if (e.type === "ON") { const d = nodes.find(n => n.id === e.from); (verdictOn.get(e.to) ?? verdictOn.set(e.to, []).get(e.to)!).push(String(d?.verdict)); }
  const wasFixed = (c: GNode) => (verdictOn.get(c.id) ?? []).some(v => v === "VETO" || v === "CORRECTED");
  // a version's predecessor: a near-copy of the text wins; else the same id if that one was blocked/corrected (a real
  // fix can reword everything); else a looser text match
  for (const c of claims) {
    if (ver(c) < 2) continue;
    const prev = claims.filter(p => ver(p) === ver(c) - 1);
    let best: GNode | null = null, bs = 0;
    for (const p of prev) { const s = overlap(c.body, p.body) + (p.rawId === c.rawId ? 0.05 : 0); if (s > bs) { bs = s; best = p; } }
    const same = prev.find(p => p.rawId === c.rawId);
    const pick = best && bs >= 0.5 ? best : same && wasFixed(same) ? same : best && bs >= 0.3 ? best : null;
    if (pick) out.push({ from: c.id, to: pick.id, type: "REVISES" });
  }
  return out;
}

function dedupe(es: GEdge[]) {
  const seen = new Set<string>();
  return es.filter(e => { const k = `${e.from}>${e.type}>${e.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- "What did I promise today?" ----------
// Every promise from today's runs, grouped by the person it was made to (or by). Two kinds:
//   commitments Scribe extracted from the transcript (owner, due, the line they came from), and
//   George's promises inside the approved-or-drafted email: the current (not superseded, not BLOCKED) claims that
//   read like a promise ("I'll…", "I will…", "we'll…") and cite a line George actually said.
// status: "kept" only when someone marked it (markPromise); followUpSent: the run's email was approved by George.
// The same promise repeated across runs (rehearsals, re-runs) is kept once: the newest.
export type PromiseItem = {
  kind: "commitment" | "claim"; id: string; runId: string; what: string; due: string | null;
  direction: "you" | "them" | "both"; status: "kept" | "open"; followUpSent: boolean;
  said: { speaker: string; t: string | null; text: string } | null; at: number;
};
export type PersonPromises = { person: string; company: string | null; promises: PromiseItem[] };

const PROMISE = /\b(i['’]ll|i will|i['’]m going to|i am going to|we['’]ll|we will|let me|i can send|i['’]d be happy to|i shall)\b/i;
const DUE = /\b(today|tonight|tomorrow|this (?:week|afternoon|evening)|next (?:week|month|monday|tuesday|wednesday|thursday|friday)|(?:by |on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: (?:morning|afternoon|evening))?|end of (?:day|week))\b/i;

export function startOfTodayPT(now = new Date()): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(now).filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
  const offset = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(now.getTime() / 1000) * 1000;
  return Date.UTC(p.year!, p.month! - 1, p.day!) - offset;
}

// Real runs only by default: a rehearsal is never presented as a conversation George had. includeRehearsals is for testing.
export async function promisesToday(opts: { since?: number; me?: string; includeTests?: boolean; includeRehearsals?: boolean } = {}): Promise<PersonPromises[]> {
  const me = (opts.me ?? "George").toLowerCase(), since = opts.since ?? startOfTodayPT();
  const isMe = (s: unknown) => String(s ?? "").toLowerCase().split(/\s+(?:and|&)\s+|,\s*/).some(x => x.trim() === me || x.trim().startsWith(me + " "));
  const runs = (await cypher<{ id: string; company: string | null; at: number; approved: number; parties: string[] }>(`MATCH (r:Run) WHERE r.at >= $since AND ($tests OR NOT r.id STARTS WITH 'test-') AND ($reh OR r.kind = 'real')
    OPTIONAL MATCH (d:Decision {runId:r.id, verdict:'APPROVED'}) OPTIONAL MATCH (p:Person)-[:IN_RUN]->(r)
    RETURN r.id AS id, r.company AS company, r.at AS at, count(DISTINCT d) AS approved, collect(DISTINCT p.name) AS parties`, { since, tests: !!opts.includeTests, reh: !!opts.includeRehearsals }));
  if (!runs.length) return [];
  const ids = runs.map(r => r.id), run = new Map(runs.map(r => [r.id, r]));
  const [lines, commits, claims, decs] = await Promise.all([
    cypher(`MATCH (l:TranscriptLine) WHERE l.runId IN $ids RETURN l{.*} AS l`, { ids }),
    cypher(`MATCH (c:Commitment) WHERE c.runId IN $ids OPTIONAL MATCH (c)-[:FROM_LINE]->(l:TranscriptLine) RETURN c{.*} AS c, l.key AS line`, { ids }),
    cypher(`MATCH (c:Claim) WHERE c.runId IN $ids OPTIONAL MATCH (c)-[:CITES]->(s) RETURN c{.*} AS c, collect(coalesce(s.key, s.id)) AS cites`, { ids }),
    cypher(`MATCH (d:Decision) WHERE d.runId IN $ids OPTIONAL MATCH (d)-[:ON]->(x) RETURN d{.*} AS d, x.key AS on`, { ids }),
  ]);
  const lineBy = new Map(lines.map((r: any) => [r.l.key, r.l]));
  const counterpart = (runId: string) => {
    const r = run.get(runId)!, spoken = [...new Set(lines.filter((x: any) => x.l.runId === runId).map((x: any) => x.l.speaker))].filter(s => s && !isMe(s));
    return (r.parties ?? []).find(p => !isMe(p)) ?? spoken[0] ?? r.company ?? "Someone";
  };
  const saidOf = (key: string | null | undefined) => { const l: any = key ? lineBy.get(key) : null; return l ? { speaker: l.speaker ?? "?", t: l.t ?? null, text: l.text ?? "" } : null; };
  const out: (PromiseItem & { person: string })[] = [];

  for (const { c, line } of commits as any[]) {
    const owner = String(c.owner ?? ""), mine = isMe(owner), other = owner && owner.split(/\s+(?:and|&)\s+|,\s*/).some(x => x.trim() && !isMe(x));
    out.push({ kind: "commitment", id: c.key, runId: c.runId, what: c.text, due: c.due ?? (String(c.text).match(DUE)?.[0] ?? null),
      direction: mine && other ? "both" : mine || !owner ? "you" : "them", status: c.status === "kept" ? "kept" : "open",
      followUpSent: (run.get(c.runId)?.approved ?? 0) > 0, said: saidOf(line), at: Number(c.at) || 0,
      person: mine || !owner ? counterpart(c.runId) : owner.split(/\s+(?:and|&)\s+|,\s*/).find(x => !isMe(x))!.trim() });
  }
  // George's promises in the email: current claim versions only, never a BLOCKED one, grounded in a line he said
  for (const runId of ids) {
    const cs = (claims as any[]).filter(x => x.c.runId === runId);
    if (!cs.length) continue;
    const nodes: GNode[] = [
      ...cs.map(x => nodeOf({ ...x.c, gid: x.c.key, label: "Claim" })),
      ...(decs as any[]).filter(x => x.d.runId === runId).map(x => nodeOf({ ...x.d, gid: x.d.key, label: "Decision" })),
    ];
    const edges: GEdge[] = [
      ...cs.flatMap(x => (x.cites ?? []).filter(Boolean).map((k: string) => ({ from: x.c.key, to: k, type: "CITES" }))),
      ...(decs as any[]).filter(x => x.d.runId === runId && x.on).map(x => ({ from: x.d.key, to: x.on, type: "ON" })),
    ];
    const es = repair(nodes, edges), byId = new Map(nodes.map(n => [n.id, n]));
    const superseded = new Set(es.filter(e => e.type === "REVISES").map(e => e.to));
    const blocked = new Set(es.filter(e => e.type === "ON" && byId.get(e.from)?.verdict === "VETO").map(e => e.to));
    for (const n of nodes) {
      if (n.label !== "Claim" || superseded.has(n.id) || blocked.has(n.id) || !PROMISE.test(String(n.body ?? ""))) continue;
      const mine = es.filter(e => e.type === "CITES" && e.from === n.id).map(e => lineBy.get(e.to)).find((l: any) => l && isMe(l.speaker));
      if (!mine) continue;
      out.push({ kind: "claim", id: n.id, runId, what: String(n.body), due: String(n.body).match(DUE)?.[0] ?? null, direction: "you",
        status: n.status === "kept" ? "kept" : "open", followUpSent: (run.get(runId)?.approved ?? 0) > 0,
        said: { speaker: (mine as any).speaker, t: (mine as any).t ?? null, text: (mine as any).text ?? "" }, at: Number(n.at) || 0, person: counterpart(runId) });
    }
  }
  // one entry per promise: the same words to the same person (re-runs, or a claim restating a commitment) → the newest,
  // a commitment winning over a claim that says the same thing in the same run
  out.sort((a, b) => b.at - a.at);
  const kept: typeof out = [];
  for (const p of out) {
    const dup = kept.find(k => k.person === p.person && contained(k.what, p.what) >= 0.6);
    if (!dup) kept.push(p);
    else if (dup.runId === p.runId && dup.kind === "claim" && p.kind === "commitment") kept[kept.indexOf(dup)] = { ...p, status: dup.status === "kept" ? "kept" : p.status };
  }
  const groups = new Map<string, PersonPromises>();
  for (const p of kept) {
    const g = groups.get(p.person) ?? groups.set(p.person, { person: p.person, company: run.get(p.runId)?.company ?? null, promises: [] }).get(p.person)!;
    const { person, ...item } = p; g.promises.push(item);
  }
  return [...groups.values()];
}

// Mark a promise kept (or open again): a Commitment by key or (runId, id), or a claim's current version.
export async function markPromise(runId: string, id: string, status: "kept" | "open") {
  await cypher(`OPTIONAL MATCH (c:Commitment) WHERE c.key = $id OR (c.runId = $runId AND c.id = $id) SET c.status = $status`, { runId, id, status });
  await cypher(`MATCH (c:Claim) WHERE c.key = $id OR (c.runId = $runId AND c.id = $id) WITH c ORDER BY c.version DESC LIMIT 1 SET c.status = $status`, { runId, id, status });
}
