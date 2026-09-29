// Deal graph facade for the workers. Every call is async, safe to fire and forget, and never throws: if Neo4j is
// down or not configured the run carries on and the graph just misses that write (one warning per process).
// Implementation: ./neo4j.ts (Neo4j Aura over HTTPS; db = the instance id).
export type SourceKind = "web" | "transcript" | "sender";
export type Verdict = "VETO" | "PASS" | "APPROVED" | "DECLINED" | "CONFIRMED" | "CORRECTED";
export type SourceIn = { runId: string; id: string; kind: SourceKind; title: string; url?: string; speaker?: string; t?: number | string; text: string };
export type ClaimIn = { runId: string; id: string; text: string; by: string; version: number; sourceIds: string[] };
export type DecisionIn = { runId: string; claimId?: string; by: string; verdict: Verdict; reason: string };
export type GNode = { id: string; label: string; text: string; [k: string]: unknown };
export type GEdge = { from: string; to: string; type: string };
export type Graph = { nodes: GNode[]; edges: GEdge[] };

const off = process.env.GRAPH === "0";
let warned = false;
async function safe<T>(what: string, fallback: T, f: (g: typeof import("./neo4j")) => Promise<T>): Promise<T> {
  if (off) return fallback;
  try { return await f(await import("./neo4j")); }
  catch (e) {
    if (!warned) { warned = true; console.warn(`[graph] ${what} skipped: ${String((e as Error)?.message ?? e).slice(0, 160)}`); }
    return fallback;
  }
}

export const recordSource = (s: SourceIn) => safe("recordSource", undefined, g => g.recordSource(s));
export const recordClaim = (c: ClaimIn) => safe("recordClaim", undefined, g => g.recordClaim(c));
export const recordDecision = (d: DecisionIn) => safe("recordDecision", undefined, g => g.recordDecision(d));
export const pathFor = (claimId: string) => safe<Graph>("pathFor", { nodes: [], edges: [] }, g => g.pathFor(claimId));

// Extras for the Deal Room (Scribe / Chief / the view).
// kind "real" only for runs started from George's own texts or recordings; anything else (and anything untagged) is a rehearsal
export const recordRun = (runId: string, info: { company?: string; title?: string; kind?: "real" | "rehearsal" } = {}) => safe("recordRun", undefined, g => g.recordRun(runId, info));
export const setRunKind = (runId: string, kind: "real" | "rehearsal") => safe("setRunKind", undefined, g => g.setRunKind(runId, kind));
export const recordTranscript = (runId: string, lines: { id?: string; speaker: string; t: number | string; text: string }[]) =>
  safe<string[]>("recordTranscript", [], g => g.recordTranscript(runId, lines));
export const recordParty = (runId: string, x: { person: string; company?: string }) => safe("recordParty", undefined, g => g.recordParty(runId, x));
export const recordCommitment = (runId: string, c: { id: string; text: string; owner?: string; due?: string; lineId?: string }) =>
  safe("recordCommitment", undefined, g => g.recordCommitment(runId, c));
export const linkSource = (runId: string, claimId: string, sourceId: string) => safe("linkSource", undefined, g => g.linkSource(runId, claimId, sourceId));
export const linkTranscript = (runId: string, claimId: string, lineId: string) => safe("linkTranscript", undefined, g => g.linkTranscript(runId, claimId, lineId));
// Latest version of each claim in the run that cites nothing. [] if the graph is unreachable (Chief's own checks still apply).
export const unsupportedClaims = (runId: string) => safe<{ id: string; version: number; text: string; by: string }[]>("unsupportedClaims", [], g => g.unsupportedClaims(runId));
export const runGraph = (runId: string) => safe<Graph & { run: string }>("runGraph", { run: runId, nodes: [], edges: [] }, g => g.runGraph(runId));
export const latestRuns = (limit = 10, opts: { rehearsals?: boolean } = {}) =>
  safe<{ id: string; company: string | null; at: number; claims: number; kind: "real" | "rehearsal" }[]>("latestRuns", [], g => g.latestRuns(limit, opts));
export const runKind = (runId: string) => safe<"real" | "rehearsal">("runKind", "rehearsal", g => g.runKind(runId));
// "What did I promise today?": today's promises (PT day) from REAL runs only, grouped by person; [] if none or the graph
// is unreachable. includeRehearsals is for testing only.
export type { PromiseItem, PersonPromises } from "./neo4j";
export const promisesToday = (opts: { since?: number; me?: string; includeTests?: boolean; includeRehearsals?: boolean } = {}) =>
  safe<import("./neo4j").PersonPromises[]>("promisesToday", [], g => g.promisesToday(opts));
export const markPromise = (runId: string, id: string, status: "kept" | "open") => safe("markPromise", undefined, g => g.markPromise(runId, id, status));
