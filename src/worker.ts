// One worker = one process (or one VM) with its own workspace and its own room identity.
//   bun src/worker.ts <Scout|Echo|Chief|FactCheck|PartnerCheck|Pricing|Tech|Legal|Scheduler>
// Env: SERVER_URL + TELEMETRY_TOKEN (display only: tiles, meter), MOCK=1 → hub room, else BAND_AGENT_ID/BAND_API_KEY.
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { isChecker, makeRole, type Role } from "./roles";
import { BandRoom, MockRoom } from "./room";

const role = (process.argv[2] ?? process.env.ROLE) as Role;
if (!["Scout", "Echo", "Chief", "Counterparty"].includes(role) && !isChecker(role)) throw new Error(`unknown role ${role}`);
const root = resolve(process.env.WORKSPACE ?? `workspaces/${role.toLowerCase()}`);
await mkdir(root, { recursive: true });

// The workspace is this worker's own disk: writes that try to leave it are refused.
const ws = {
  async write(name: string, body: string) {
    const p = resolve(join(root, name));
    if (!p.startsWith(root + "/")) throw new Error(`boundary: ${role} may not write outside its workspace`);
    await Bun.write(p, body);
  },
};

const server = process.env.SERVER_URL;
const report = (kind: string, data: Record<string, unknown>) => {
  if (!server) return;
  fetch(`${server}/telemetry`, {
    method: "POST", headers: { "content-type": "application/json", "x-telemetry": process.env.TELEMETRY_TOKEN ?? "" },
    body: JSON.stringify({ worker: role, kind, at: Date.now(), ...data }),
  }).catch(() => {});
};

const mock = process.env.MOCK === "1" || !process.env.BAND_API_KEY;
const room = mock ? new MockRoom(process.env.HUB_URL ?? "ws://localhost:7990/hub") : new BandRoom();
const identity = {
  pid: process.pid, host: process.env.VM_HOST ?? hostname(), vm: process.env.VM_ID ?? null, region: process.env.VM_REGION ?? null,
  workspace: root.replace(process.env.HOME ?? "~", "~"), room: mock ? "mock hub" : "Band",
  agentId: process.env.BAND_AGENT_ID ? `${process.env.BAND_AGENT_ID.slice(0, 8)}…` : null,
};
report("status", { status: "booting", detail: "", identity });
const handle = makeRole(role, report, ws);
await room.join(role, async (m, ctx) => {
  // one Band room hosts many runs (free tier: 10 rooms per account), so state is keyed by run and every
  // handoff carries the run id forward
  const run = m.payload?.run;
  // after a re-add Band redelivers any backlog; a handoff older than the run timeout belongs to a dead run
  if (!m.payload?.at || Date.now() - m.payload.at > 240_000) return;
  const scoped = { ...m, roomId: run ? `${m.roomId}#${run}` : m.roomId };
  const sctx = { ...ctx, send: (t: string, mentions: string[], p?: unknown) => ctx.send(t, mentions, run ? { ...(p as object ?? {}), run, at: m.payload?.at } : p) };
  try { await handle(scoped, sctx); }
  catch (e) {
    report("event", { roomId: ctx.roomId, eventKind: "error", text: `${role} failed: ${String(e).slice(0, 200)}` });
    report("status", { status: "error", detail: String(e).slice(0, 80), identity });
    await ctx.event("error", `${role} failed: ${String(e).slice(0, 200)}`).catch(() => {});
  }
});
report("status", { status: "joined", detail: mock ? "mock hub" : "Band", identity });
setInterval(() => report("heartbeat", { identity, rss: Math.round(process.memoryUsage().rss / 1e6) }), 5000);
