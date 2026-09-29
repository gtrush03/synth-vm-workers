// SYNTH: VM Workers: the web view + Desk (George's side of the room).
//   bun src/server.ts        (MOCK=1 for no keys; PORT defaults to 7990)
// The server never tells a worker what to do. Desk opens a room and posts the task; after that the workers
// coordinate only through the room. The server just mirrors what they report, so you can watch.
import { createHash, randomBytes } from "node:crypto";
import { loadExecutors } from "./tasks";
import { calendarCheck, inviteIcs, slotFrom } from "./tasks/scheduler";
import { makeRunner } from "./tasks/runner";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { existsSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { loadKeys } from "./keys";
import { decode, encode } from "./room";
import { BandDesk } from "./desk-band";
import { sendEmail, validEmail } from "./mail";
import { graphRoutes } from "./graph/routes";
import * as graph from "./graph";
import { startBridge } from "./app-bridge";
import { think } from "./llm";
import { parseTranscript, scribe } from "./scribe";
import type { Scribe } from "./roles";

const PORT = Number(process.env.PORT ?? 7990);
const keys = await loadKeys();
if (keys.crusoe && process.env.MOCK_LLM !== "1") process.env.CRUSOE_API_KEY = keys.crusoe;
const MOCK = process.env.MOCK === "1" || !keys.band;
// stable across restarts: the Vultr workers hold this token (infra/vultr syncs it from runs/telemetry-token.txt)
const TOKEN = process.env.TELEMETRY_TOKEN ?? ((await Bun.file("runs/telemetry-token.txt").text().catch(() => "")).trim() || randomBytes(16).toString("hex"));   // workers → /telemetry (display only)
const API_TOKEN = process.env.DEALROOM_TOKEN ?? await (async () => {
  const p = Bun.spawn(["security", "find-generic-password", "-s", "hackday-dealroom-token", "-w"], { stdout: "pipe", stderr: "ignore" });
  const t = (await new Response(p.stdout).text()).trim(); return t || undefined;
})();
const ADMIN = process.env.ADMIN_KEY ?? randomBytes(9).toString("base64url");   // approve needs it
const CORE = ["Scout", "Echo", "Chief", "FactCheck"];
// specialists Chief can recruit at runtime, spawned only if their Band agent exists (or always in the mock room)
const EXTRA = ["PartnerCheck", "Pricing", "Tech", "Legal", "Scheduler", "Counterparty"].filter(n => keys.band ? keys.band[n] : ["PartnerCheck", "Counterparty"].includes(n));
const WORKERS = [...CORE, ...EXTRA];
// a different Crusoe model per worker: spreads the per-model rate limit and shows multi-model routing
const MODELS: Record<string, string> = { Scout: "deepseek-ai/Deepseek-V4-Flash", Echo: "openai/gpt-oss-120b", Chief: "deepseek-ai/DeepSeek-V4-Pro", FactCheck: "deepseek-ai/Deepseek-V4-Flash",
  Pricing: "deepseek-ai/Deepseek-V4-Flash", Tech: "deepseek-ai/Deepseek-V4-Flash", Legal: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B", Scheduler: "deepseek-ai/Deepseek-V4-Flash", PartnerCheck: "deepseek-ai/Deepseek-V4-Flash", Counterparty: "openai/gpt-oss-120b" };
// PartnerCheck (the other org's checker) thinks on a different model family, through OpenRouter, with Crusoe behind it
const PARTNER_OR_MODEL = process.env.PARTNER_MODEL ?? "anthropic/claude-haiku-4.5";
// FACTCHECK_VIA=openrouter (stage only: the free tier is ~50 calls/day) puts FactCheck on another family via OpenRouter
const FACTCHECK_OR = process.env.FACTCHECK_VIA === "openrouter";
const OR_FACTCHECK_MODEL = process.env.OR_FACTCHECK_MODEL ?? "inclusionai/ling-3.0-flash-sante:free";;
const IN_ROOM_AT_START = ["Scout", "Echo", "Chief"];          // checkers are recruited mid-task by Chief
await mkdir("runs", { recursive: true });
await Bun.write("runs/admin-url.txt", `http://localhost:${PORT}/?k=${ADMIN}\n`);
await Bun.write("runs/telemetry-token.txt", `${TOKEN}\n`);   // for Vultr workers (infra/vultr); runs/ is git-ignored

// ---------- state + SSE ----------
type Line = { at: number; from: string; text: string; mentions: string[]; tone: string; kind: string; issues?: any[] };
type Run = { id: string; kind?: string; subject?: string; company: string; to?: string; who?: string; ask?: string; transcript?: string; dry?: boolean; source?: string; sent?: any; task: string; roomId: string; started: number; status: string; lines: Line[]; final?: any; decision?: string; ended?: number };
const runs = new Map<string, Run>();
let current: Run | null = null;
// Runs survive restarts: a waiting draft and its decision (idempotency) must never be lost mid-judging.
const STATE = "runs/state.json";
try {
  const saved: Run[] = JSON.parse(await Bun.file(STATE).text());
  for (const r of saved) {
    if (r.status === "running" || r.status === "sending") { r.status = "interrupted"; r.ended ??= Date.now(); }
    runs.set(r.id, r);
  }
  current = saved.at(-1) ?? null;
  console.log(`restored ${saved.length} runs${current ? `, current ${current.id} (${current.status})` : ""}`);
} catch {}
let saveT: Timer | null = null;
const save = () => { saveT ??= setTimeout(async () => { saveT = null; await Bun.write(STATE, JSON.stringify([...runs.values()].slice(-40))); }, 300); };
const MOCK_LLM = !keys.crusoe || process.env.MOCK_LLM === "1";
const tiles: Record<string, any> = Object.fromEntries(WORKERS.map(w => [w, { name: w, status: "off", detail: "", files: [], identity: null, inRoom: false, model: MOCK_LLM ? "mock LLM" : w === "PartnerCheck" && keys.openrouter ? `via OpenRouter · ${PARTNER_OR_MODEL}` : w === "FactCheck" && FACTCHECK_OR ? `via OpenRouter · ${OR_FACTCHECK_MODEL}` : `Crusoe · ${MODELS[w]}`,
  org: w === "PartnerCheck" || w === "Counterparty" ? "the other company (2nd Band account)" : "TRU Synth" }]));
const meter = { calls: 0, tokens: 0, ms: 0, last: null as any, byProvider: {} as Record<string, number>, history: [] as any[] };
const clients = new Set<ReadableStreamDefaultController>();
let bridge = { changed() {} };
const push = (type: string, data: unknown) => {
  if (type !== "meter") bridge.changed();
  if (type === "run" || type === "card") save();
  const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) try { c.enqueue(publicClients.has(c) ? redact(chunk) : chunk); } catch { clients.delete(c); publicClients.delete(c); }
};
// the live browser wall: each worker's screencast frames (last one kept per worker) and its marks, on their own SSE
const frameClients = new Set<ReadableStreamDefaultController>();
const lastFrame: Record<string, string> = {}, lastPublicFrame: Record<string, string> = {};
// the same frames for pollers (Cloudflare quick tunnels don't pass SSE): latest per worker + recent marks, stamped with server time
const pollFrames: Record<string, any> = {};
// under x-public, own views that show private words (a real transcript, George's promises) go out without the picture
const PRIVATE_VIEW = /^synth:\/\/(transcript|memory)/;
const publicFrame = (f: any) => PRIVATE_VIEW.test(f.url ?? "") ? { ...f, jpeg: "", caption: "(own view, not shown publicly)" } : f;
const publicFrameClients = new Set<ReadableStreamDefaultController>();
const pollMarks: any[] = [];
const pushFrame = (type: "frame" | "mark", data: any) => {
  const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  if (type === "frame") { lastFrame[data.worker] = chunk; pollFrames[data.worker] = { ...data, t: Date.now() }; }
  else { pollMarks.push({ ...data, t: Date.now() }); if (pollMarks.length > 100) pollMarks.shift(); }
  const pubChunk = type === "frame" && PRIVATE_VIEW.test(data.url ?? "") ? `event: frame\ndata: ${JSON.stringify(publicFrame(data))}\n\n` : chunk;
  if (type === "frame") lastPublicFrame[data.worker] = pubChunk;
  for (const c of frameClients) try { c.enqueue(publicFrameClients.has(c) ? pubChunk : chunk); } catch { frameClients.delete(c); publicFrameClients.delete(c); }
};
const line = (r: Run | null, l: Omit<Line, "at">) => {
  if (!r) return;
  const x = { at: Date.now(), ...l };
  r.lines.push(x);
  push("line", { runId: r.id, ...x });
};
const tile = (name: string, patch: any) => { Object.assign(tiles[name] ??= { name, files: [] }, patch); push("tile", tiles[name]); };
// live.trusynth.com proxies read-only pages with x-public: 1. Public copies carry no email address and no transcript text.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// a contact's name never goes public either (full name and first name of every run's contact)
const contactRe = () => {
  const names = new Set<string>();
  for (const r of runs.values()) if (r.who) { const w = r.who.trim(); if (w.length >= 3) names.add(w); const f = w.split(/\s+/)[0]!; if (f.length >= 3) names.add(f); }
  return names.size ? new RegExp(`\\b(${[...names].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi") : null;
};
const redact = (json: string) => { const re = contactRe(); return (re ? json.replace(re, "the contact") : json).replace(EMAIL_RE, "(address hidden)").replace(/"transcript":"(?:[^"\\]|\\.)*"/g, '"transcript":"(private)"'); };
const isPublic = (req: Request) => req.headers.get("x-public") === "1";
const publicClients = new Set<ReadableStreamDefaultController>();
// proxies (cloudflared, the live.trusynth.com Worker) buffer quiet streams: never transform, and say something every 5 s
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };
setInterval(() => { for (const set of [clients, frameClients]) for (const c of set) try { c.enqueue(`: keepalive ${Date.now()}\n\n`); } catch { set.delete(c); } }, 5000);
const PUBLIC_BASE = process.env.PUBLIC_BASE ?? "https://live.trusynth.com";
const snapshot = () => ({ mode: MOCK ? "mock" : "live", model: process.env.CRUSOE_MODEL ?? "openai/gpt-oss-120b", tiles, meter, run: current });

// ---------- mock room hub (routes by @mention, members only, like Band) ----------
type HubWs = ServerWebSocket<{ name: string }>;
const hubMembers = new Map<string, HubWs>();
const hubRooms = new Map<string, Set<string>>();
function hubSend(roomId: string, from: string, content: string, mentions: string[]) {
  const members = hubRooms.get(roomId);
  if (!members?.has(from)) return { ok: false, error: `${from} is not in this room` };
  const id = randomBytes(6).toString("hex");
  for (const to of mentions) {
    if (!members.has(to)) continue;          // not in the room → never sees it
    if (to === "Desk") { setTimeout(() => deskReceive({ id, roomId, from, content }), 150); continue; }
    hubMembers.get(to)?.send(JSON.stringify({ op: "deliver", id, roomId, from, content }));
  }
  return { ok: true, id };
}

// ---------- Desk: opens the room, posts the task, gates the ship on Chief's pass + George's yes ----------
const band = MOCK ? null : new BandDesk(keys, (m) => deskReceive(m));
async function openRoom(title: string): Promise<string> {
  if (band) return band.openRoom(IN_ROOM_AT_START, title);
  const id = `mock-${randomBytes(4).toString("hex")}`;
  hubRooms.set(id, new Set(["Desk", ...IN_ROOM_AT_START]));
  return id;
}
async function deskPost(roomId: string, text: string, mentions: string[], payload?: unknown) {
  if (band) return band.post(roomId, encode(text, payload), mentions);
  hubSend(roomId, "Desk", encode(text, payload), mentions);
}
async function deskReceive(m: { id: string; roomId: string; from: string; content: string }) {
  const { payload: p0 } = decode(m.content);
  const r = p0?.run ? runs.get(p0.run) : undefined;   // only messages carrying a live run id count
  if (!r || r.status !== "running") return;   // late or replayed messages for a finished run are ignored
  const { payload } = decode(m.content);
  if (m.from !== "Chief") {   // the enforced boundary: only Chief can put something in front of George
    line(r, { from: "Desk", text: `Refused a submission from ${m.from}: only Chief can pass work to George.`, mentions: [], tone: "veto", kind: "gate" });
    return;
  }
  if (payload?.pass) {
    if (r.subject) payload.draft.subject = r.subject;   // e.g. "Deal Synth rehearsal"
    // the click-in: part of the body BEFORE George sees it, so what he approves (content_sha) is exactly what sends
    // the time the other side's agent agreed becomes a real calendar invite on the email (shown on George's card)
    const slot = payload.change ? slotFrom(payload.change) : null;
    if (slot) {
      payload.invite = { start: slot.start.toISOString(), label: slot.label, cto: /cto/i.test(payload.change) };
      // keep what both sides agreed, but tell George if his own calendar says he's busy then
      const cal = await calendarCheck(slot.start).catch(() => null);
      if (cal?.busy) payload.invite.conflict = `Your calendar shows ${slot.label.replace(/ \d{4}-\d{2}-\d{2} at/, "")} busy.${cal.next ? ` Scheduler's next free slot is ${cal.next}.` : ""}`;
    }
    payload.draft.body = `${payload.draft.body}\n\nWatch how your Synths made this: ${PUBLIC_BASE}/shipped/${r.id}`;
    r.status = "awaiting approval"; r.final = payload;
    line(r, { from: "Desk", text: r.dry ? `Dry run: v${payload.version} passed; no card goes to George's phone and nothing sends.` : `Approval card sent to George's phone (v${payload.version}). Nothing leaves until he says yes.`, mentions: [], tone: "gate", kind: "gate" });
    push("card", { runId: r.id, ...payload });
  } else {
    r.status = "blocked"; r.ended = Date.now();
    push("run", r);
  }
}

type RunOpts = { kind?: "real" | "rehearsal"; subject?: string; to?: string; who?: string; ask?: string; transcript?: string; transcriptVia?: string; dry?: boolean; source?: string };
async function startRun(company: string, o: RunOpts = {}) {
  const to = o.to;
  const task = o.ask ? `${o.ask} (${o.who ? `${o.who} at ` : ""}${company})` : `Research ${company} and write a short follow-up email from George (TRU Synth)${o.who ? ` to ${o.who}` : ""}${to ? ` <${to}>` : ""}`;
  const id = randomBytes(4).toString("hex");
  const roomId = await openRoom(`${company} · run ${id}`);
  const r: Run = { id, kind: o.kind === "real" && !o.dry ? "real" : "rehearsal", subject: o.subject, company, to, who: o.who, ask: o.ask, transcript: o.transcript, dry: o.dry, source: o.source, task, roomId, started: Date.now(), status: "running", lines: [] };
  runs.set(r.id, r); current = r;
  Object.assign(meter, { calls: 0, tokens: 0, ms: 0, last: null, byProvider: {} });   // history spans runs (the panel wants it)
  push("meter", meter);
  setTimeout(() => { if (r.status === "running") { r.status = "timed out"; r.ended = Date.now(); line(r, { from: "Desk", text: "No pass from Chief within 4 minutes. Nothing shipped.", mentions: [], tone: "veto", kind: "gate" }); push("run", r); } }, 240_000);
  for (const w of WORKERS) tile(w, { recruitedAt: null, inRoom: IN_ROOM_AT_START.includes(w), status: tiles[w].status === "off" ? "off" : "joined", detail: "", files: [] });
  push("run", r);
  line(r, { from: "Desk", text: `${MOCK ? "Opened a mock room" : "Band room ready"} ${roomId.slice(0, 13)}: Scout, Echo and Chief in; checkers on standby, not in the room.`, mentions: [], tone: "system", kind: "system" });
  graph.recordRun(r.id, { company, title: task, kind: r.kind as any });   // only "real" runs count in "what did I promise today"
  if (o.who) graph.recordParty(r.id, { person: o.who, company });
  kickoff(r, o).catch(e => line(r, { from: "Desk", text: `Desk failed to start the room: ${String(e).slice(0, 160)}`, mentions: [], tone: "veto", kind: "gate" }));
  return r;
}

// The trip-wire: a conversation landed. Desk (watcher + scribe) turns it into evidence, then hands the room the task.
async function kickoff(r: Run, o: RunOpts) {
  const lines = o.transcript ? parseTranscript(o.transcript) : [];
  let sc: Scribe | undefined;
  if (lines.length) {
    line(r, { from: "Desk", text: `Conversation received${o.source === "api" ? "" : ""}: ${lines.length} lines, ${new Set(lines.map(l => l.speaker)).size} speakers${o.transcriptVia ? ` · ${o.transcriptVia}` : ""}.`, mentions: [], tone: "system", kind: "system" });
    graph.recordTranscript(r.id, lines.map(l => ({ id: `L${l.id}`, speaker: l.speaker, t: l.t, text: l.text })));
    const { scribe: x, llm } = await scribe(lines, { who: o.who, company: r.company });
    sc = x;
    telemetry({ worker: "Desk", kind: "llm", label: "scribe", provider: llm.provider, model: llm.model, ms: llm.ms, tokens: llm.tokens, inTokens: llm.inTokens, outTokens: llm.outTokens, fallbacks: llm.fallbacks ?? [] });
    x.commitments.forEach((c, i) => graph.recordCommitment(r.id, { id: `C${i + 1}`, text: c.text, owner: c.owner, due: c.due, lineId: c.line ? `L${c.line - 100}` : undefined }));
    const flags = Object.entries(x.flags).filter(([, v]) => v).map(([k]) => k);
    line(r, { from: "Desk", text: `Scribe: "${x.topic}". Needs: ${x.needs.join("; ") || "none"}. Commitments: ${x.commitments.map(c => `${c.owner}: ${c.text}${c.due ? ` (${c.due})` : ""}`).join("; ") || "none"}.${flags.length ? ` Talk touched: ${flags.join(", ")}.` : ""}`, mentions: [], tone: "event", kind: "thought" });
  }
  const text = `@Scout ${r.task}.${sc ? ` They said they need: ${sc.needs.join("; ") || "see the conversation"}.` : ""} Hand your findings to @Echo. Nothing is final until @Chief passes it.`;
  line(r, { from: "Desk", text, mentions: ["Scout"], tone: "", kind: "message" });
  await deskPost(r.roomId, text, ["Scout"], { run: r.id, at: Date.now(), company: r.company, task: r.task, to: r.to, who: o.who, lines, scribe: sc });
}

async function decide(r: Run, yes: boolean) {
  if (r.status !== "awaiting approval") return;   // idempotent: the first decision wins (phone, iMessage and web can race)
  r.status = yes ? "sending" : "declined";
  await Bun.write(STATE, JSON.stringify([...runs.values()].slice(-40)));   // the decision is on disk before any email goes
  r.decision = yes ? "approved" : "declined"; r.ended = Date.now();
  graph.recordDecision({ runId: r.id, by: "George", verdict: yes ? "APPROVED" : "DECLINED", reason: yes ? "approved on his phone" : "not this one" });
  if (!yes) {
    r.status = "declined";
    line(r, { from: "Desk", text: `George said "not this one". Nothing was sent.`, mentions: ["Chief"], tone: "veto", kind: "message" });
    await deskPost(r.roomId, `@Chief George said "not this one". Nothing was sent.`, ["Chief"]).catch(() => {});
    push("run", r); return;
  }
  // the ship: a real email if George gave an address, else the public shipped page only
  if (r.to) {
    r.sent = r.dry ? { ok: true, dry: true, id: "dry-run" } : await sendEmail(keys.resend, r.to, r.final.draft.subject, r.final.draft.body, r.final.invite ? [{ filename: "invite.ics", content_type: "text/calendar; method=REQUEST", content: Buffer.from(inviteIcs(new Date(r.final.invite.start), 30, `${r.company} x TRU Synth`, `Agreed in the Deal Room. ${r.final.invite.cto ? "Please bring your CTO." : ""}`.trim(), [r.to!])).toString("base64") }] : undefined);
    const text = r.sent.ok ? (r.dry ? `George approved v${r.final.version}. DRY RUN: nothing was sent to ${r.to}.` : `George approved v${r.final.version}. Email SENT to ${r.to}.`) : `George approved v${r.final.version}, but the email was NOT sent: ${r.sent.error}.`;
    line(r, { from: "Desk", text, mentions: ["Chief"], tone: r.sent.ok ? "pass" : "veto", kind: "message" });
    await deskPost(r.roomId, `@Chief ${text}`, ["Chief"]).catch(() => {});
  } else {
    line(r, { from: "Desk", text: `George approved v${r.final.version}. Published at /shipped/${r.id} (no outreach sent).`, mentions: ["Chief"], tone: "pass", kind: "message" });
    await deskPost(r.roomId, `@Chief George approved v${r.final.version}. Published.`, ["Chief"]).catch(() => {});
  }
  r.status = r.to && !r.sent?.ok ? "send failed" : "shipped";
  if (r.sent?.ok && !r.dry) (graph as any).markPromise?.(r.id, "C1", "kept");
  await Bun.write(`runs/${r.id}.json`, JSON.stringify(r, null, 1));
  push("run", r);
}

// ---------- workers: each its own process + workspace (Vultr VMs replace these when VM_MODE=vultr) ----------
const procs = new Map<string, Bun.Subprocess>();
// the non-secret part of each worker's env; infra/vultr reads runs/worker-spec.json and adds keys from the Keychain
function workerSpec(name: string): Record<string, string> {
  const e: Record<string, string> = { CRUSOE_MODEL: process.env[`MODEL_${name.toUpperCase()}`] ?? MODELS[name]!, MOCK: MOCK ? "1" : "0" };
  if (name === "Chief") e.RECRUITABLE = EXTRA.concat("FactCheck").join(",");
  if (name === "PartnerCheck" && keys.openrouter) { e.LLM_PRIMARY = "openrouter"; e.OPENROUTER_MODEL = PARTNER_OR_MODEL; }
  if (name === "FactCheck" && FACTCHECK_OR && keys.openrouter) { e.LLM_PRIMARY = "openrouter"; e.OPENROUTER_MODEL = OR_FACTCHECK_MODEL; }
  return e;
}
await Bun.write("runs/worker-spec.json", JSON.stringify(Object.fromEntries(WORKERS.map(w => [w, workerSpec(w)])), null, 1));

// ONE headless Chrome of our own (never George's shared Chrome on 9876); every local worker opens its own tab in it
const CDP_PORT = 9377;
let chrome: ReturnType<typeof Bun.spawn> | null = null;
const CDP_URL = process.env.SYNTH_FRAMES === "0" ? "" : await (async () => {
  const bin = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!await Bun.file(bin).exists()) return "";
  chrome = Bun.spawn([bin, "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${process.env.TMPDIR ?? "/tmp/"}svw-chrome`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 40; i++) { if (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(r => r.ok).catch(() => false)) return `http://127.0.0.1:${CDP_PORT}`; await Bun.sleep(250); }
  return "";
})();
console.log(CDP_URL ? `live browsers: one headless Chrome on :${CDP_PORT}, one tab per local worker` : "live browsers off");

// workers outlive a crashed or killed server; reap any stale ones first, or they pile up (141 once) and fight for Band sockets
Bun.spawnSync(["pkill", "-f", "bun src/worker.ts"]);
await Bun.sleep(300);

function spawnWorker(name: string) {
  const env: Record<string, string> = {
    ...process.env as any, SERVER_URL: `http://localhost:${PORT}`, TELEMETRY_TOKEN: TOKEN, HUB_URL: `ws://localhost:${PORT}/hub`,
    WORKSPACE: `workspaces/${name.toLowerCase()}`, MOCK: MOCK ? "1" : "0",
    ...(CDP_URL ? { SYNTH_FRAMES: "1", CDP_URL } : {}),
  };
  if (keys.crusoe) env.CRUSOE_API_KEY = keys.crusoe;
  if (keys.openrouter) env.OPENROUTER_API_KEY = keys.openrouter;
  if (keys.brave && name === "Scout") env.BRAVE_API_KEY = keys.brave;
  const b = keys.band?.[name];
  if (b) { env.BAND_AGENT_ID = b.id; env.BAND_API_KEY = b.key; }
  Object.assign(env, workerSpec(name));
  if (process.env.MOCK_LLM === "1") delete env.CRUSOE_API_KEY;
  const p = Bun.spawn(["bun", "src/worker.ts", name], { env, stdout: "inherit", stderr: "inherit" });
  procs.set(name, p);
  p.exited.then(() => { tile(name, { status: "off", detail: "process exited" }); });
}

// ---------- http ----------
const server = Bun.serve<{ name: string }>({
  port: PORT,
  idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    const g = await graphRoutes(req).catch(() => null);   // 8e's deal graph + Crusoe panel pages
    if (g) return g;
    if (p === "/hub") {
      if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1")) return new Response("local only", { status: 403 });
      return srv.upgrade(req, { data: { name: url.searchParams.get("name") ?? "?" } }) ? undefined : new Response("no", { status: 400 });
    }
    if (p === "/" || p === "/card") return new Response(Bun.file("public/index.html"));
    const pub = isPublic(req);
    if (p === "/events") {
      let ctl: ReadableStreamDefaultController;
      return new Response(new ReadableStream({
        start(c) { ctl = c; clients.add(c); if (pub) publicClients.add(c); const h = JSON.stringify(snapshot()); c.enqueue(`event: hello\ndata: ${pub ? redact(h) : h}\n\n`); },
        cancel() { clients.delete(ctl); publicClients.delete(ctl); },
      }), { headers: SSE_HEADERS });
    }
    if (p.startsWith("/api/run") || p.startsWith("/api/tasks") || p.startsWith("/api/approve/") || p.startsWith("/api/reject/") || p === "/api/chat") return api(req, url);
    if (p === "/state") return pub ? new Response(redact(JSON.stringify(snapshot())), { headers: { "content-type": "application/json" } }) : Response.json(snapshot());
    if (p === "/run" && req.method === "POST") {
      const { company, email, k } = await req.json().catch(() => ({})) as any;
      if (k !== ADMIN) return new Response("forbidden", { status: 403 });
      const down = WORKERS.filter(w => !["joined", "idle", "handed off", "passed", "waiting", "vetoed", "working", "blocked"].includes(tiles[w].status) || Date.now() - (tiles[w].seen ?? 0) > 15_000);
      if (down.length) return Response.json({ error: `not connected yet: ${down.join(", ")}` }, { status: 503 });
      if (current?.status === "running") return Response.json({ error: "a run is in progress" }, { status: 409 });
      const name = String(company ?? "").replace(/[^\p{L}\p{N} .&-]/gu, "").trim().slice(0, 60);
      if (!name) return Response.json({ error: "company required" }, { status: 400 });
      const to = String(email ?? "").trim();
      if (to && !validEmail(to)) return Response.json({ error: "that email doesn't look right" }, { status: 400 });
      if (to && [...runs.values()].some(x => x.to === to && x.sent?.ok)) return Response.json({ error: "already sent one email to that address" }, { status: 409 });
      try { return Response.json(await startRun(name, { to: to || undefined, source: "web" })); }
      catch (e: any) { return Response.json({ error: `room: ${String(e?.body?.error?.message ?? e).slice(0, 160)}` }, { status: 502 }); }
    }
    if (p === "/approve" && req.method === "POST") {
      const { runId, yes, k } = await req.json().catch(() => ({})) as any;
      if (k !== ADMIN) return new Response("forbidden", { status: 403 });
      const r = runs.get(runId);
      if (!r || r.status !== "awaiting approval") return Response.json({ error: "nothing awaiting approval" }, { status: 409 });
      await decide(r, !!yes);
      return Response.json({ ok: true, status: r.status, to: r.to ?? null, sent: r.sent ?? null, shipped: yes ? `/shipped/${r.id}` : null });
    }
    if (p.startsWith("/shipped/")) {
      const r = runs.get(p.split("/")[2] ?? "");
      if (!r || r.decision !== "approved") return new Response("not shipped", { status: 404 });
      return new Response(pub ? redact(shippedPage(r)) : shippedPage(r), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (p === "/frames") {
      let ctl: ReadableStreamDefaultController;
      return new Response(new ReadableStream({
        start(c) { ctl = c; frameClients.add(c); if (pub) publicFrameClients.add(c); c.enqueue(": frames\n\n"); for (const f of Object.values(pub ? lastPublicFrame : lastFrame)) c.enqueue(f); },
        cancel() { frameClients.delete(ctl); publicFrameClients.delete(ctl); },
      }), { headers: SSE_HEADERS });
    }
    if (p === "/frames/poll") {
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const strip = ({ t, ...x }: any) => x;
      return Response.json({ now: Date.now(), frames: Object.values(pollFrames).filter(f => f.t > since).map(strip).map(f => pub ? publicFrame(f) : f), marks: pollMarks.filter(m => m.t > since).map(strip) }, { headers: { "cache-control": "no-store" } });
    }
    if ((p === "/frame" || p === "/frame/mark") && req.method === "POST") {
      if (req.headers.get("x-telemetry") !== TOKEN) return new Response("no", { status: 403 });
      const f = await req.json().catch(() => null) as any;
      if (!f?.worker) return new Response("bad", { status: 400 });
      if (p === "/frame") pushFrame("frame", { worker: String(f.worker), jpeg: String(f.jpeg ?? ""), url: String(f.url ?? ""), caption: String(f.caption ?? ""), local: !!f.local, idle: !!f.idle, at: Number(f.at) || Date.now() });
      else pushFrame("mark", { worker: String(f.worker), kind: String(f.kind), text: String(f.text ?? "").slice(0, 300), at: Number(f.at) || Date.now() });
      return new Response("ok");
    }
    if (p === "/telemetry" && req.method === "POST") {
      if (req.headers.get("x-telemetry") !== TOKEN) return new Response("no", { status: 403 });
      telemetry(await req.json());
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws: HubWs) { hubMembers.set(ws.data.name, ws); },
    close(ws: HubWs) { if (hubMembers.get(ws.data.name) === ws) hubMembers.delete(ws.data.name); },
    message(ws: HubWs, raw) {
      const m = JSON.parse(String(raw));
      const me = ws.data.name;
      const reply = (result: unknown) => { ws.send(JSON.stringify({ rid: m.rid, result })); };
      if (m.op === "send") return reply(hubSend(m.roomId, me, m.content, m.mentions ?? []));
      if (m.op === "event") return reply({ ok: true });   // workers report their own events for display
      if (m.op === "lookupPeers") return reply([...hubMembers.keys()].filter(n => n !== me));
      if (m.op === "removeParticipant") {
        hubRooms.get(m.roomId)?.delete(m.name); tile(m.name, { inRoom: false });
        return reply({ ok: true });
      }
      if (m.op === "addParticipant") {
        const room = hubRooms.get(m.roomId);
        if (!room?.has(me)) return reply({ ok: false, error: "not in room" });
        room.add(m.name); tile(m.name, { inRoom: true });
        return reply({ ok: true });
      }
      reply({ ok: false, error: "unknown op" });
    },
  },
});

// ---------- the Deal Room API (Chief's `dealroom` tool on iMessage drives this) ----------
const API_STATUS: Record<string, string> = { running: "running", "awaiting approval": "awaiting_approval", shipped: "sent", declined: "rejected" };
function apiView(r: Run) {
  return {
    runId: r.id, status: API_STATUS[r.status] ?? "failed", detail: r.status, company: r.company, who: r.who ?? null, to: r.to ?? null, dry: !!r.dry,
    summary: r.final ? `${r.final.draft.subject} (Chief passed v${r.final.version})` : null,
    subject: r.final?.draft.subject ?? null, body: r.final?.draft.body ?? null, slot: r.final?.slot ?? null,
    sent: r.sent ?? null, started: new Date(r.started).toISOString(), ended: r.ended ? new Date(r.ended).toISOString() : null,
  };
}
async function api(req: Request, url: URL): Promise<Response> {
  if (!API_TOKEN || req.headers.get("authorization") !== `Bearer ${API_TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parts = url.pathname.split("/").filter(Boolean);            // api, run, <id>, approve
  const id = parts[1] === "run" ? parts[2] : parts[2];
  const action = parts[1] === "run" ? parts[3] : parts[1];
  if (parts[1] === "run" && !id && req.method === "POST") {
    const b = await req.json().catch(() => ({})) as any;
    const company = String(b.company ?? "").replace(/[^\p{L}\p{N} .&-]/gu, "").trim().slice(0, 60);
    const to = String(b.email ?? "").trim();
    if (!company) return Response.json({ error: "company required" }, { status: 400 });
    if (to && !validEmail(to)) return Response.json({ error: "bad email" }, { status: 400 });
    if (current?.status === "running") return Response.json({ error: "a run is in progress", runId: current.id }, { status: 409 });
    try {
      const r = await startRun(company, { to: to || undefined, who: String(b.who ?? "").slice(0, 80) || undefined, ask: String(b.ask ?? "").slice(0, 400) || undefined,
        transcript: b.transcript ? String(b.transcript).slice(0, 12_000) : undefined, transcriptVia: b.transcriptVia ? String(b.transcriptVia).slice(0, 60) : undefined, subject: b.subject ? String(b.subject).slice(0, 120) : undefined, kind: b.kind === "real" ? "real" : "rehearsal", dry: !!b.dry, source: "api" });
      return Response.json({ runId: r.id, status: "running" });
    } catch (e: any) { return Response.json({ error: `room: ${String(e?.body?.error?.message ?? e).slice(0, 160)}` }, { status: 502 }); }
  }
  if (parts[1] === "chat" && req.method === "POST") {
    const b = await req.json().catch(() => ({})) as any;
    return Response.json({ text: await dealChat(String(b.text ?? "")) });
  }
  if (url.pathname.startsWith("/api/tasks")) {
    const [, , , a, b] = url.pathname.split("/");   // /api/tasks[/<synth>/propose | /<taskId>/approve|decline]
    if (req.method === "GET" && !a) return Response.json(runner.all());
    if (req.method === "POST" && b === "propose") return Response.json(await runner.propose(a!));
    if (req.method === "POST" && (b === "approve" || b === "decline")) { try { return Response.json(b === "approve" ? runner.approve(a!, "api") : runner.decline(a!)); } catch (e) { return Response.json({ error: String(e) }, { status: 404 }); } }
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const r = id ? runs.get(id) : undefined;
  if (!r) return Response.json({ error: "no such run" }, { status: 404 });
  if (req.method === "GET" && !action) return Response.json(apiView(r));
  if (req.method === "POST" && (action === "approve" || action === "reject")) {
    if (r.status !== "awaiting approval") return Response.json({ alreadyDecided: true, ...apiView(r) }, { status: r.decision ? 200 : 409 });
    await decide(r, action === "approve");
    return Response.json(apiView(r));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

// Every source, claim and verdict lands in the Neo4j deal graph (8e's module; never throws)
function recordGraph(r: Run, by: string, g: any) {
  for (const s of g.sources ?? []) graph.recordSource({ runId: r.id, id: String(s.id), kind: "web", title: s.title, url: s.url, text: s.text });
  if (g.checks) g.checks.forEach((c: any, i: number) => {
    const src = c.src == null ? [] : Number(c.src) >= 100 ? [`L${Number(c.src) - 100}`] : Number(c.src) === 0 ? ["sender"] : [String(c.src)];
    graph.recordClaim({ runId: r.id, id: `c${i + 1}`, text: c.claim, by: "Echo", version: g.version, sourceIds: c.supported ? src : [] });
    graph.recordDecision({ runId: r.id, claimId: `c${i + 1}`, by, verdict: c.supported ? "CONFIRMED" : "CORRECTED", reason: c.note ?? "" });
  });
  if (g.verdict) {
    for (const i of g.issues ?? []) graph.recordDecision({ runId: r.id, by, verdict: "VETO", reason: `${i.claim}: ${i.note ?? "no evidence"}` });
    if (g.verdict === "PASS") graph.recordDecision({ runId: r.id, by, verdict: "PASS", reason: `v${g.version} passed` });
  }
}

// Deal Synth's chat (the app and the web): a short answer about the current run, on Crusoe
async function dealChat(text: string): Promise<string> {
  if (/promis|owe|commit/i.test(text)) {
    // answered from the Neo4j deal graph across today's REAL runs, every item traceable to the second it was said
    const groups: any[] = await (graph as any).promisesToday?.().catch(() => []) ?? [];
    const items = groups.flatMap(g => g.promises.map((p: any) => ({ ...p, person: g.person, company: g.company })));
    if (!items.length) return "No promises from real conversations today yet.";
    const open = items.filter(p => p.status !== "kept");
    return `${items.length} promise${items.length === 1 ? "" : "s"} today, ${open.length} still open. ` + items.slice(0, 6).map(p =>
      `${p.direction === "them" ? `${p.person} owes you` : `You promised ${p.person}${p.company ? ` (${p.company})` : ""}`}: ${p.what}${p.due ? `, due ${p.due}` : ""}${p.said?.t ? ` (said at ${p.said.t})` : ""}, ${p.status}${p.followUpSent ? ", follow-up sent" : ""}.`).join(" ");
  }
  const r = current;
  const ctx = r ? `Current run: ${r.task}. Status: ${r.status}.${r.final ? ` Draft subject: ${r.final.draft.subject}.` : ""} Last events:\n${r.lines.slice(-8).map(l => `${l.from}: ${l.text.slice(0, 160)}`).join("\n")}` : "No run yet today.";
  try {
    const x = await think([
      { role: "system", content: "You are Deal Synth in George's TRU Synth app. You run the Deal Room: Scout researches, Echo writes, Chief checks and can block, a recruited checker verifies, and nothing sends without George's yes. Answer in 1-3 short plain sentences. No em dashes, no emoji." },
      { role: "user", content: `${ctx}\n\nGeorge asks: ${text.slice(0, 500)}` },
    ], { model: "deepseek-ai/Deepseek-V4-Flash", maxTokens: 400, mock: () => r ? `The Deal Room is ${r.status} for ${r.company}.` : "Nothing is running right now." });
    telemetry({ worker: "Desk", kind: "llm", label: "chat", provider: x.provider, model: x.model, ms: x.ms, tokens: x.tokens, fallbacks: x.fallbacks ?? [] });
    return x.text.trim();
  } catch { return r ? `The Deal Room is ${r.status} for ${r.company}.` : "Nothing is running right now."; }
}

function telemetry(t: any) {
  const w = t.worker as string;
  const r = current;
  // a heartbeat revives a tile (a VM worker's "joined" may have gone to the server before a restart)
  if (t.kind === "status" || t.kind === "heartbeat") tile(w, { ...(t.status ? { status: t.status, detail: t.detail ?? "" } : tiles[w]?.status === "off" || !tiles[w]?.status ? { status: "joined" } : {}), identity: t.identity ?? tiles[w]?.identity, rss: t.rss ?? tiles[w]?.rss, seen: Date.now() });
  if (t.kind === "file") tile(w, { files: [...(tiles[w].files ?? []), t.name].slice(-6) });
  if (t.kind === "llm") {
    meter.calls++; meter.tokens += t.tokens; meter.ms += t.ms; meter.byProvider[t.provider] = (meter.byProvider[t.provider] ?? 0) + 1;
    meter.last = { worker: w, label: t.label, model: t.model, provider: t.provider, ms: t.ms, tokens: t.tokens, inTokens: t.inTokens, outTokens: t.outTokens, fallbacks: t.fallbacks ?? [], at: Date.now(), runId: r?.id ?? null };
    meter.history = [...meter.history, meter.last].slice(-60);
    push("meter", meter);
    line(r, { from: w, text: `thought on ${t.provider === "mock" ? "mock" : t.provider === "crusoe" ? "Crusoe" : "OpenRouter"} · ${t.model} · ${t.ms} ms · ${t.tokens} tok${t.fallbacks?.length ? ` · after ${t.fallbacks.length} failover(s): ${t.fallbacks.join("; ")}` : ""}`, mentions: [], tone: "llm", kind: "llm" });
  }
  if (t.kind === "sent" && t.graph && r) recordGraph(r, w, t.graph);
  if (t.kind === "sent" && t.tone === "recruit" && t.who && r) tile(t.who, { inRoom: true, recruitedAt: Math.round((Date.now() - r.started) / 1000) });
  if (t.kind === "sent" && t.tone === "dismiss" && t.who) tile(t.who, { inRoom: false, detail: "dismissed after its job" });
  if (t.kind === "sent") line(r, { from: w, text: t.text, mentions: t.mentions ?? [], tone: t.tone ?? "", kind: t.tone === "recruit" ? "system" : "message", issues: t.issues });
  if (t.kind === "event") line(r, { from: w, text: t.text, mentions: [], tone: t.eventKind === "error" ? "veto" : "event", kind: t.eventKind });
  if (t.kind === "recruit") line(r, { from: w, text: `lookupPeers → ${t.peers.join(", ")}`, mentions: [], tone: "event", kind: "tool_call" });
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
function shippedPage(r: Run) {
  const f = r.final;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shipped pitch</title>
<style>body{background:#000;color:#eee;font:16px/1.55 -apple-system,system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 16px}h1{color:#ecd3a0;font-weight:600}
.k{color:#8a8a8a;font-size:13px}.b{border:1px solid #2a2a2a;border-radius:14px;padding:18px;margin:18px 0;white-space:pre-wrap}a{color:#ecd3a0}</style>
<p class="k">SYNTH Deal Room · sent ${new Date(r.ended!).toISOString().slice(0, 16).replace("T", " ")}Z · approved by George · to ${esc(r.who ?? "the team")} at ${esc(r.company)}</p>
<h1>${esc(f.draft.subject)}</h1><div class="b">${esc(f.draft.body)}</div>
<p class="k">Sources Chief checked:</p><ol class="k">${f.sources.map((s: any) => `<li><a href="${esc(s.url)}">${esc(s.title)}</a></li>`).join("")}</ol>
<p class="k">Researched by Scout, drafted by Echo on Crusoe, checked by ${esc(f.checker ?? "a recruited checker")}, passed by Chief at v${f.version}. Nothing left until George tapped Approve. <a href="/wall">Watch the Synths work</a> · <a href="/graph">the deal graph</a></p>`;
}

// Deal Synth in George's app: token from env or Keychain, never logged
const dealToken = process.env.DEAL_TOKEN ?? await (async () => {
  const p = Bun.spawn(["security", "find-generic-password", "-s", "hackday-deal-token", "-w"], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim() || undefined;
})();
// TEAM: Synths that propose a task, run it live after George's yes, and leave proof (src/tasks)
const TEAM_IDS = ["research", "scheduler", "ops", "qa", "growth", "finance", "memory", "social"];
const runner = makeRunner((await loadExecutors()).filter(e => TEAM_IDS.includes(e.synth)), {
  server: `http://localhost:${PORT}`, token: TOKEN, cdp: CDP_URL || undefined, keys: keys as any,
  changed: t => {
    push("task", t);
    // a team Synth gets a wall tile while it works: where it runs and its model, from the task itself
    if (t.status !== "proposed" && t.status !== "declined") tile(t.synth, { name: t.synth, label: t.synthName, status: t.status === "running" ? "working" : t.status === "done" ? "idle" : t.status, detail: t.line ?? "", identity: { host: hostname(), vm: t.where.vm, region: t.where.region, workspace: `runs/proof/${t.taskId}`, room: "TEAM" }, model: t.model ?? "", org: "TRU Synth", seen: Date.now(), team: true });
    // every card keeps one pending task: after one ends, the Synth proposes its next
    if (["done", "failed", "declined"].includes(t.status)) setTimeout(() => runner.propose(t.synth).then(() => bridge.changed()).catch(() => {}), 5000);
  },
  log: s => console.log(`[team] ${s}`),
});
await runner.restore();
for (const e of runner.executors()) await runner.propose(e.synth).catch(e2 => console.log(`[team] propose ${e.synth} failed: ${e2}`));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// the app's house style: no em dashes, no emoji
const plainText = (s: string) => s.replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
const taskBody = (e: any, t: any) => t.body ?? `${t.task}\n\nWhat happens after your yes: ${e.name} opens its own browser on this Mac and does this live, read-only (no sign-ins, nothing sent to anyone but you). You can watch it, and it leaves a proof page.`;
// team-social needs f0's allowlist first (a 400 would reject the whole doc): on when runs/team-social.ok exists
const docAllowed = (synth: string) => synth !== "social" || existsSync("runs/team-social.ok");
function teamDoc() {
  return runner.executors().filter(e => docAllowed(e.synth)).map(e => {
    const id = `team-${e.synth}`, mine = runner.all().filter(t => t.synth === e.synth);
    const open = mine.filter(t => t.status === "proposed"), live = mine.filter(t => t.status === "running" || t.status === "approved");
    const ended = mine.filter(t => t.ended && t.status !== "declined").sort((a, b) => b.ended! - a.ended!);
    const last = ended[0];
    const ref = (t: any) => `synths/${id}/outbox/${t.taskId}.md`;
    return {
      card: { id, title: e.name, purpose: plainText(`${e.title}. ${live[0]?.line ?? (last ? `Last: ${last.summary ?? last.error ?? last.status}` : "Ready for its first task.")}`),
        state: live.length ? "running" : open.length ? "waiting-on-george" : "done", ...(last ? { lastRun: { at: new Date(last.ended!).toISOString(), status: last.status === "done" ? "done" : "failed" } } : {}) },
      // the Synth's own proposed task first, then any intro drafts a finished task left (Growth); max 10 per card
      approvals: [
        ...(live.length ? [] : open.slice(0, 1).map(t => {
          const body = taskBody(e, t);
          return { type: "draft", synth: id, key: ref(t), file: ref(t), ref: ref(t), title: plainText(t.task), status: "draft", at: new Date(t.proposed).toISOString(),
            ask: plainText(t.why ?? ""), body, content_sha: sha(body),
            view: { who: e.name, rec: "yes", why: plainText(t.why ?? ""), question: plainText(`${t.task}?`), context: plainText(`Runs in its own live browser on this Mac. Uses ${e.sponsors.join(", ")}.`), yes: `${e.name} starts this now.`, no: `${e.name} drops this task.` } };
        })),
        ...ended.flatMap(t => t.proofs.filter(p => p.kind === "intro" && !p.data.decided).map(p => {
          const intro = p.data, f = `synths/${id}/outbox/${t.taskId}-${intro.n}.md`, body = plainText(`${intro.subject}\n\n${intro.body}`);
          return { type: "draft", synth: id, key: f, file: f, ref: f, title: plainText(`Intro to ${intro.company}`), status: "draft", at: new Date(t.ended ?? Date.now()).toISOString(),
            ask: "A draft only. Approving keeps it; nothing is sent from here.", body, content_sha: sha(body),
            view: { who: e.name, rec: "yes", why: plainText(`Found for: ${t.task}.`), question: plainText(`Keep this intro to ${intro.company}?`), context: "Draft only. Nothing is sent to anyone.", yes: `${e.name} keeps this draft.`, no: `${e.name} drops this draft.` } };
        })),
      ].slice(0, 10),
      running: live.slice(0, 1).map(t => ({ synth: id, status: plainText(t.line ?? "Starting"), since: new Date(t.started ?? t.approved?.at ?? Date.now()).toISOString(), at: new Date().toISOString() })),
      notes: plainText([`${e.name} (${e.title}).`, ...mine.slice(-5).map(t => `${t.task}: ${t.status}${t.summary ? `, ${t.summary}` : ""}${t.error ? `, failed: ${t.error}` : ""}.`)].join("\n")).slice(0, 3900),
      proof: [...live, ...open.slice(0, 1), ...ended].slice(0, 10).flatMap(t => [
        { url: `${PUBLIC_BASE}/wall?synth=${e.synth}&task=${t.taskId}`, host: "Watch live", note: plainText(t.task).slice(0, 120), from: ref(t) },
        { url: `${PUBLIC_BASE}/proof/${t.taskId}`, host: "Proof", note: plainText(t.summary ?? t.error ?? t.status).slice(0, 120), from: ref(t) },
      ]),
    };
  });
}
async function teamInbox(row: any) {
  const e = runner.executors().find(x => `team-${x.synth}` === row.synth);
  if (!e) return { status: "failed", error: "That Synth is not on the team." };
  const refId = String(row.ref ?? "").match(/outbox\/([^.]+)\.md/)?.[1] ?? "";
  const introOf = /^(.+)-(\d+)$/.exec(refId);
  const introTask = introOf ? runner.get(introOf[1]!) : undefined;
  if (introTask && (row.kind === "approve" || row.kind === "reject")) {
    // intros stay drafts whatever George taps: approving keeps one, rejecting drops it, nothing is ever sent
    const p = introTask.proofs.find(x => x.kind === "intro" && x.data.n === Number(introOf![2]));
    if (!p) return { status: "failed", error: "That draft is gone." };
    p.data.decided = row.kind === "approve" ? "kept" : "dropped"; runner.touch(introTask);
    return { status: "sent", text: row.kind === "approve" ? `Kept the intro to ${p.data.company} as a draft. Nothing was sent.` : "Dropped." };
  }
  const taskId = refId;
  const t = taskId ? runner.get(taskId) : undefined;
  if (row.kind === "approve" || row.kind === "reject") {
    if (!t) return { status: "failed", error: "That task is no longer open." };
    if (row.kind === "reject") { runner.decline(t.taskId); return { status: "sent", text: "Dropped." }; }
    if (row.content_sha && row.content_sha !== sha(taskBody(e, t))) return { status: "failed", error: "The card changed since you looked." };
    // Social: only a real tap posts; a test tap runs the same flow dry (typed, never posted)
    if (e.synth === "social") { runner.approve(t.taskId, row.real ? "app" : "app (test tap)", row.real ? { dry: false, sha: String(row.content_sha ?? ""), ref: String(row.ref ?? "") } : { dry: true }); return { status: "sent", text: row.real ? "Social Synth is posting it now." : "Test tap: Social Synth types it without posting." }; }
    if (!row.real) return { status: "failed", text: "Test approval received. Nothing ran." };
    runner.approve(t.taskId, "app");
    return { status: "sent", text: `${e.name} started. Watch it from Watch live on its card.` };
  }
  if (row.kind === "start") {
    const open = runner.all().find(x => x.synth === e.synth && x.status === "proposed");
    return { status: "sent", text: open ? `Waiting for your yes on: ${open.task}` : "Working on it." };
  }
  const text = String(row.text ?? "");
  if (/pause after this step/i.test(text)) { runner.pause(e.synth); return { status: "sent", text: `${e.name} will pause after this step and wait for you.` }; }
  if (/carry on now/i.test(text)) { const was = runner.isPaused(e.synth); runner.resume(e.synth); return { status: "sent", text: was ? `${e.name} is carrying on.` : `${e.name} was not paused.` }; }
  const mine = runner.all().filter(x => x.synth === e.synth).slice(-3);
  return { status: "sent", text: mine.length ? mine.map(x => `${x.task}: ${x.status}${x.summary ? `. ${x.summary}` : ""}${x.ended ? ". The proof is on its card" : ""}.`).join("\n") : `${e.name} has no tasks yet.` };
}

// George's in-app Live view: while a Synth works, its browser goes to /box/v1/blob/live.jpg (≤2/s; 409 = view closed)
const screenToken = (await Bun.file("runs/screen-token.txt").text().catch(() => "")).trim();
if (screenToken) {
  let lastSent = "", backoff = 0;
  const liveSeen = new Set<string>();   // log each (synth, status) once: the end-to-end proof for 5f
  const active = (): string | null => {
    const t = runner.all().find(x => x.status === "running");
    if (t) return t.synth;
    if (current?.status !== "running" || current.dry) return null;   // dry runs never reach his phone
    const busy = Object.values(pollFrames).filter((f: any) => !f.idle && !PRIVATE_VIEW.test(f.url ?? "") && Date.now() - f.t < 8000).sort((a: any, b: any) => b.t - a.t);
    return (busy[0] as any)?.worker ?? null;
  };
  setInterval(async () => {
    if (Date.now() < backoff) return;
    const w = active(); if (!w) return;
    const f: any = pollFrames[w];
    if (!f?.jpeg || PRIVATE_VIEW.test(f.url ?? "") || f.jpeg === lastSent) return;
    lastSent = f.jpeg;
    const r = await fetch("https://app-staging.trusynth.com/box/v1/blob/live.jpg", { method: "PUT", headers: { authorization: `Bearer ${screenToken}`, "content-type": "image/jpeg" }, body: Buffer.from(f.jpeg, "base64"), signal: AbortSignal.timeout(8000) }).catch(() => null);
    const k = `${w}:${r?.status ?? "err"}`; if (!liveSeen.has(k)) { liveSeen.add(k); console.log(`[app] live.jpg ${w} → ${r?.status ?? "no answer"}`); }
    if (!r || r.status === 409) backoff = Date.now() + 3000;
    else if (r.status === 429) backoff = Date.now() + 1000;
    else if (!r.ok) { backoff = Date.now() + 30_000; console.log(`[app] live.jpg push ${r.status}`); }
  }, 600);
}

// George's Live view: the working Synth's steps + address bar (PUT /deal/v1/live), {synth:null} when it ends
if (dealToken) {
  let lastFeed = "", shown: string | null = null, lastAt = 0;
  setInterval(async () => {
    const t = runner.all().find(x => x.status === "running");
    let body: any;
    if (t) {
      const feed = t.proofs.filter(p => p.kind === "step" && p.data.text).slice(-100).map(p => ({ what: plainText(String(p.data.text)).slice(0, 200), tool: "browser", at: new Date(p.at).toISOString() }));
      const u = [...t.proofs].reverse().find(p => p.data?.url && /^https:/.test(p.data.url) && !/[?&#](token|key|sig|auth|code|secret|session)=/i.test(p.data.url))?.data.url;
      body = { synth: `team-${t.synth}`, feed, tabs: u ? [{ url: u, title: plainText(t.line ?? t.task).slice(0, 120) }] : [] };
    } else if (current?.status === "running" && !current.dry) {
      body = { synth: "deal", feed: current.lines.filter(l => l.kind !== "llm").slice(-100).map(l => ({ what: plainText(`${l.from}: ${l.text.replace(/\s+/g, " ")}`).replace(EMAIL_RE, "(address hidden)").slice(0, 200), tool: l.kind === "tool_call" ? "browser" : "band", at: new Date(l.at).toISOString() })), tabs: [] };
    } else body = shown ? { synth: null } : null;
    if (!body) return;
    const j = JSON.stringify(body);
    if (j === lastFeed && (!body.synth || Date.now() - lastAt < 30_000)) return;   // the view drops a feed after 60 s of silence
    const r = await fetch("https://app-staging.trusynth.com/deal/v1/live", { method: "PUT", headers: { authorization: `Bearer ${dealToken}`, "content-type": "application/json" }, body: j.length > 32_000 ? JSON.stringify({ ...body, feed: body.feed.slice(-40) }) : j, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (r?.ok) { if (body.synth !== shown) console.log(`[app] live feed ${body.synth ?? "cleared"} → ${r.status} (${body.feed?.length ?? 0} steps)`); lastFeed = j; shown = body.synth; lastAt = Date.now(); } else if (r) console.log(`[app] live feed ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`);
  }, 3000);
}

bridge = startBridge(dealToken, {
  team: teamDoc, teamInbox,
  // dry runs (tests) never reach George's app: it shows the latest run that could really send
  current: () => current && !current.dry ? current : [...runs.values()].reverse().find(x => !x.dry) ?? null, run: id => runs.get(id), decide: (r, yes) => decide(r as Run, yes), chat: dealChat,
  helpers: () => {
    const inRoom = Object.values(tiles).filter((t: any) => t.inRoom && t.name !== "Desk");
    const busy = inRoom.filter((t: any) => /working|waiting|vetoed/.test(t.status)).map((t: any) => `${t.name} ${t.detail || t.status}`);
    return `${inRoom.length} helpers in the Band room${busy.length ? `: ${busy.join("; ")}` : ""}.`;
  },
  notes: () => {
    const r = current;
    if (!r) return "No Deal Room run yet today. Text Chief who you met and the Deal Room opens.";
    const where = (w: string) => tiles[w]?.identity?.vm ? `on a Vultr VM in ${tiles[w].identity.region}` : "on George's Mac";
    const said = r.lines.filter(l => l.kind === "message" && l.from !== "Desk").slice(-8).map(l => `${l.from} said: ${l.text.replace(/\s+/g, " ").slice(0, 220)}`);
    const stage = r.status === "awaiting approval" ? `Chief passed version ${r.final?.version}; the draft waits for George's yes or no in the app. Nothing sends before that.`
      : r.status === "running" ? "The Band room is still working on the draft." : r.status === "shipped" ? `George approved and Resend delivered the email${r.to ? ` to ${r.to}` : ""}.` : `The run ended as ${r.status}.`;
    return [`Deal Room run ${r.id} (${r.kind ?? "rehearsal"}) for ${r.who ? `${r.who} at ` : ""}${r.company}.`,
      `Workers: Scout ${where("Scout")}, Echo ${where("Echo")}, Chief ${where("Chief")}; every one thinks on Crusoe models, with OpenRouter as fallback. Claims, sources and promises go to the Neo4j deal graph.${r.transcript ? " The conversation came in as a transcript and the Scribe pulled the commitments out of it." : ""}`,
      ...said, `Stage: ${stage}`].join("\n");
  },
  log: (t) => console.log(`[app] ${t}`),
});

// VM_ROLES=Scout,Echo,... run on their own Vultr VMs (infra/vultr); never also locally, or a Band key would answer twice
// With VM_MODE=vultr the roles listed in runs/vms.json (written by infra/vultr) are skipped here too.
let vmFile: any[] = [];
try { if (process.env.VM_MODE === "vultr") { const j = JSON.parse(await Bun.file("runs/vms.json").text()); vmFile = (Array.isArray(j) ? j : j.vms ?? []).filter((v: any) => v.worker === "active" || v.status === "active"); } } catch {}
const VM_ROLES = [...(process.env.VM_ROLES ?? "").split(",").filter(Boolean), ...vmFile.map(v => v.role).filter(Boolean)];
for (const v of vmFile) if (v.role) tile(v.role, { vmPlanned: true, identity: { vm: String(v.id ?? "").slice(0, 8), region: v.region, host: v.ip ? String(v.ip).replace(/\.\d+$/, ".x") : v.label, workspace: `/var/lib/synth/${String(v.role).toLowerCase()}`, room: "Band" } });
if (VM_ROLES.length) console.log(`on Vultr VMs (not spawned here): ${VM_ROLES.join(", ")}`);
for (const w of WORKERS) if (!VM_ROLES.includes(w)) spawnWorker(w);
if (band) await band.start();
console.log(`SYNTH: VM Workers on :${PORT} (${MOCK ? "MOCK room" : "Band room"}, ${keys.crusoe && process.env.MOCK_LLM !== "1" ? "Crusoe" : "mock LLM"}). Admin URL in runs/admin-url.txt`);
process.on("SIGINT", () => { for (const p of procs.values()) p.kill(); chrome?.kill(); process.exit(0); });
process.on("SIGTERM", () => { for (const p of procs.values()) p.kill(); chrome?.kill(); process.exit(0); });
