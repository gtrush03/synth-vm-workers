// Live check of the deal graph against Neo4j Aura: records a tiny demo-shaped run, checks the veto query and the
// claim path, then deletes that run (KEEP=1 keeps it for the graph view).   bun scripts/graph-aura-check.ts
import * as G from "../src/graph";
import { configured, deleteRun, ensureSchema } from "../src/graph/neo4j";

const ok: string[] = [], bad: string[] = [];
const check = (name: string, cond: unknown, got?: unknown) => (cond ? ok : bad).push(cond ? name : `${name} (got ${JSON.stringify(got)?.slice(0, 200)})`);
if (!(await configured())) { console.log("neo4j not configured (Keychain hackday-neo4j or NEO4J_JSON)"); process.exit(2); }
await ensureSchema();
const run = `test-${Date.now().toString(36)}`, t0 = performance.now();

await G.recordRun(run, { company: "Acme Clinics", title: "graph check" }); // no kind: counts as a rehearsal
const lines = await G.recordTranscript(run, [
  { speaker: "Judge", t: "0:05", text: "We're building a scheduling tool for clinics." },
  { speaker: "George", t: "0:12", text: "Would a call next Tuesday work?" },
  { speaker: "Judge", t: "0:20", text: "Tuesday works. Send me the deck." },
]);
await G.recordParty(run, { person: "Judge", company: "Acme Clinics" });
await G.recordSource({ runId: run, id: "S1", kind: "web", title: "Acme Clinics raises seed", url: "https://example.com/acme", text: "Acme Clinics ..." });
await G.recordClaim({ runId: run, id: "c1", text: "You mentioned 10k users", by: "Echo", version: 1, sourceIds: [] });
await G.recordClaim({ runId: run, id: "c2", text: "You're building a scheduling tool for clinics", by: "Echo", version: 1, sourceIds: ["L1"] });
await G.recordClaim({ runId: run, id: "c3", text: "Acme just raised a seed round", by: "Echo", version: 1, sourceIds: ["S1"] });
await G.recordCommitment(run, { id: "k1", text: "Call next Tuesday", owner: "Judge", due: "Tue", lineId: "L3" });
const u1 = await G.unsupportedClaims(run);
check("transcript ids", lines.join() === "L1,L2,L3", lines);
check("unsupported before the veto = [c1]", u1.length === 1 && u1[0]!.id === "c1", u1);

await G.recordDecision({ runId: run, claimId: "c1", by: "Chief", verdict: "VETO", reason: "'10k users' is not in the transcript at any timestamp" });
await G.recordClaim({ runId: run, id: "c1", text: "You said Tuesday works for a call", by: "Echo", version: 2, sourceIds: ["L3"] });
await G.recordDecision({ runId: run, claimId: "c1", by: "FactCheck", verdict: "CONFIRMED", reason: "matches Judge at 0:20" });
await G.recordDecision({ runId: run, claimId: "c1", by: "Chief", verdict: "PASS", reason: "every claim cites a source" });
const u2 = await G.unsupportedClaims(run);
check("unsupported after the fix = []", u2.length === 0, u2);

const p = await G.pathFor(`${run}:c1:v2`);
const labels = p.nodes.map(n => n.label).sort().join(",");
const types = [...new Set(p.edges.map(e => e.type))].sort().join(",");
check("path has both versions, the line, the speaker, 3 decisions", labels === "Claim,Claim,Decision,Decision,Decision,Person,TranscriptLine", labels);
check("path edges CITES, ON, REVISES, SAID", types === "CITES,ON,REVISES,SAID", types);
check("VETO sits on v1", p.edges.some(e => e.type === "ON" && e.to === `${run}:c1:v1` && p.nodes.find(n => n.id === e.from)?.verdict === "VETO"), p.edges);
check("line text reaches the path", p.nodes.some(n => n.label === "TranscriptLine" && /Tuesday works/.test(n.text)), p.nodes.map(n => n.text));
const byBare = await G.pathFor("c1");
check("pathFor(bare id) finds the newest run's c1", byBare.nodes.some(n => n.id === `${run}:c1:v2`), byBare.nodes.map(n => n.id));

const g = await G.runGraph(run);
check("run graph: 14 nodes (3 lines, source, 4 claims, commitment, 3 decisions, 2 people)", g.nodes.length === 14, g.nodes.map(n => n.label));
check("every edge has both ends", g.edges.every(e => g.nodes.some(n => n.id === e.from) && g.nodes.some(n => n.id === e.to)), g.edges);
check("latestRuns lists it", (await G.latestRuns(5)).some(r => r.id === run));
check("untagged run counts as a rehearsal", (await G.runKind(run)) === "rehearsal" && !(await G.latestRuns(50, { rehearsals: false })).some(r => r.id === run));

// "What did I promise today?": a grounded promise in the email, the other side's commitment, a blocked promise that must not count
const since = Date.now() - 120_000;
await G.recordClaim({ runId: run, id: "c4", text: "I'll send you the benchmark tonight", by: "Echo", version: 1, sourceIds: ["L2"] });
await G.recordClaim({ runId: run, id: "c5", text: "I'll send you our pricing", by: "Echo", version: 1, sourceIds: [] });
await G.recordClaim({ runId: run, id: "c6", text: "I'll give you a 50% discount", by: "Echo", version: 1, sourceIds: ["L2"] });
await G.recordDecision({ runId: run, claimId: "c6", by: "Chief", verdict: "VETO", reason: "no discount was offered" });
const mine = (await G.promisesToday({ since, includeTests: true, includeRehearsals: true })).filter(g => g.promises.some(p => p.runId === run));
const judge = mine.find(g => g.person === "Judge"), items = judge?.promises ?? [];
check("promises grouped under Judge (Acme Clinics)", mine.length === 1 && judge?.company === "Acme Clinics", mine.map(g => g.person));
check("2 promises: their Tuesday call + your grounded benchmark", items.length === 2
  && items.some(p => p.kind === "commitment" && p.direction === "them" && p.said?.t === "0:20")
  && items.some(p => p.kind === "claim" && p.direction === "you" && p.due === "tonight" && p.said?.speaker === "George" && p.said?.t === "0:12"), items);
check("ungrounded + BLOCKED promises left out", !items.some(p => /pricing|discount/.test(p.what)), items.map(p => p.what));
check("open, follow-up not sent yet", items.every(p => p.status === "open" && !p.followUpSent), items);
await G.recordDecision({ runId: run, by: "George", verdict: "APPROVED", reason: "approved on his phone" });
await G.markPromise(run, "c4", "kept");
const after = (await G.promisesToday({ since, includeTests: true, includeRehearsals: true })).find(g => g.person === "Judge")?.promises ?? [];
check("after approve + mark: follow-up sent, benchmark kept", after.every(p => p.followUpSent) && after.find(p => p.kind === "claim")?.status === "kept", after);
// Honesty rule: rehearsals never show as real conversations. Default = real runs only; the flag is for tests.
const forRun = (gs: Awaited<ReturnType<typeof G.promisesToday>>) => gs.some(g => g.promises.some(p => p.runId === run));
check("default promisesToday leaves the rehearsal out", !forRun(await G.promisesToday({ since, includeTests: true })));
await G.setRunKind(run, "real");
await G.recordRun(run, { company: "Acme Clinics" }); // a later recordRun without kind keeps the tag
check("tagged real: in promisesToday + real-only runs", (await G.runKind(run)) === "real" && forRun(await G.promisesToday({ since, includeTests: true }))
  && (await G.latestRuns(50, { rehearsals: false })).some(r => r.id === run && r.kind === "real"));
await G.setRunKind(run, "rehearsal");
check("tagged rehearsal: out again", !forRun(await G.promisesToday({ since, includeTests: true })));
check("promisesToday never throws, [] when none", Array.isArray(await G.promisesToday({ since: Date.now() + 86_400_000 })) && (await G.promisesToday({ since: Date.now() + 86_400_000 })).length === 0);

if (process.env.KEEP !== "1") await deleteRun(run);
console.log(`${bad.length ? "FAIL" : "PASS"} ${ok.length}/${ok.length + bad.length} in ${Math.round(performance.now() - t0)} ms (run ${run}${process.env.KEEP === "1" ? " kept" : " deleted"})`);
for (const b of bad) console.log("  ✗", b);
process.exit(bad.length ? 1 : 0);
