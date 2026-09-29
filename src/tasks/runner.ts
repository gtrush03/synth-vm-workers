// Runs approved TEAM tasks, one at a time per Synth, each in its own browser tab streamed to /frames.
// Everything is persisted: runs/tasks.json (the queue) and runs/proof/<taskId>.json (8e's proof page reads it).
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { makeEye, type Eye } from "../browser";
import { think } from "../llm";
import type { Executor, TaskCtx } from "./types";

export type Task = {
  taskId: string; synth: string; synthName: string; task: string; why?: string; kind: string; input: Record<string, unknown>;
  where: { host: string; vm: string | null; region: string | null }; model?: string; body?: string;
  status: "proposed" | "approved" | "running" | "done" | "failed" | "declined"; error?: string; summary?: string; line?: string;
  approved: { by: string; at: number; via: string } | null; proposed: number; started?: number; ended?: number;
  proofs: { kind: string; data: any; at: number }[];
};
type Deps = { server: string; token: string; cdp?: string; keys: Record<string, string | undefined>; changed(t: Task): void; log(s: string): void };

const FILE = "runs/tasks.json", PROOF = "runs/proof";
export function makeRunner(executors: Executor[], d: Deps) {
  const ex = new Map(executors.map(e => [e.synth, e]));
  const tasks = new Map<string, Task>();
  const eyes = new Map<string, Eye>();
  const busy = new Set<string>();
  const paused = new Set<string>();   // George's Live-view Pause: the Synth stops before its next browser step
  let saveT: Timer | null = null;
  const save = () => { saveT ??= setTimeout(async () => { saveT = null; await Bun.write(FILE, JSON.stringify([...tasks.values()].slice(-200))); }, 300); };
  const writeProof = (t: Task) => Bun.write(`${PROOF}/${t.taskId}.json`, JSON.stringify(t, null, 1)).catch(() => {});
  const touch = (t: Task) => { save(); writeProof(t); d.changed(t); };

  async function restore() {
    await mkdir(PROOF, { recursive: true });
    try {
      for (const t of JSON.parse(await Bun.file(FILE).text()) as Task[]) {
        if (t.status === "running" || t.status === "approved") { t.status = "failed"; t.error = "interrupted by a server restart"; t.ended ??= Date.now(); writeProof(t); }
        tasks.set(t.taskId, t);
      }
    } catch {}
  }

  // one open proposal per Synth: its Review card
  async function propose(synth: string): Promise<Task> {
    const open = [...tasks.values()].find(t => t.synth === synth && t.status === "proposed");
    if (open) return open;
    const e = ex.get(synth); if (!e) throw new Error(`no such Synth ${synth}`);
    const p = await e.propose();
    const t: Task = { taskId: `${synth}-${randomBytes(3).toString("hex")}`, synth, synthName: e.name, task: p.task, why: p.why, kind: e.kind, input: p.input ?? {},
      where: { host: "this Mac", vm: null, region: null }, model: "Crusoe · deepseek-ai/Deepseek-V4-Flash", status: "proposed", approved: null, proposed: Date.now(), proofs: [], ...(p.body ? { body: p.body } : {}) };
    tasks.set(t.taskId, t); touch(t);
    return t;
  }

  function decline(taskId: string) {
    const t = tasks.get(taskId); if (!t || t.status !== "proposed") return t;
    t.status = "declined"; t.ended = Date.now(); touch(t); return t;
  }

  // approve → run live. Idempotent: a second approve of the same task does nothing.
  function approve(taskId: string, via: string, input: Record<string, unknown> = {}) {
    const t = tasks.get(taskId); if (!t) throw new Error("no such task");
    if (t.status !== "proposed") return t;
    Object.assign(t.input, input);
    t.status = "approved"; t.approved = { by: via === "app" || via === "imessage" ? "George" : "a test", at: Date.now(), via };   // only George's own tap says George touch(t);
    run(t).catch(() => {});
    return t;
  }

  async function run(t: Task) {
    while (busy.has(t.synth)) await Bun.sleep(1000);
    busy.add(t.synth);
    const e = ex.get(t.synth)!;
    const eye = eyes.get(t.synth) ?? makeEye(t.synth, () => {}, { server: d.server, token: d.token, cdp: d.cdp, on: true });
    eyes.set(t.synth, eye);
    const hold = async () => { if (!paused.has(t.synth)) return; const was = t.line; t.line = "Paused: waiting for you"; touch(t); while (paused.has(t.synth)) await Bun.sleep(500); t.line = was; touch(t); };
    // every browser move first checks for a pause, so "pause after this step" holds between steps
    const page = new Proxy(eye, { get: (o: any, k) => typeof o[k] === "function" && ["goto", "view", "highlight", "scroll", "type"].includes(String(k)) ? async (...a: any[]) => { await hold(); return o[k](...a); } : o[k] }) as typeof eye;
    const ac = new AbortController(); const cap = setTimeout(() => ac.abort(), 600_000);
    let n = 0;
    const ctx: TaskCtx = {
      taskId: t.taskId, synth: t.synth, input: t.input, page, keys: d.keys, signal: ac.signal,
      log(line) { t.line = line.slice(0, 200); t.proofs.push({ kind: "step", data: { text: line, url: page.where().startsWith("http") ? page.where() : undefined }, at: Date.now() }); touch(t); },
      proof(kind, data) { t.proofs.push({ kind, data, at: Date.now() }); touch(t); },
      async shot(caption) {
        const b64 = await page.shot(); if (!b64) return;
        const file = `${++n}.jpg`;
        await Bun.write(`${PROOF}/${t.taskId}/${file}`, Buffer.from(b64, "base64"));
        t.proofs.push({ kind: "shot", data: { file, url: page.where().startsWith("http") ? page.where() : undefined, caption }, at: Date.now() }); touch(t);
      },
      frame(jpeg, caption, url) {
        fetch(`${d.server}/frame`, { method: "POST", headers: { "content-type": "application/json", "x-telemetry": d.token }, body: JSON.stringify({ worker: t.synth, jpeg, caption, url: url ?? "", local: false, at: Date.now() }) }).catch(() => {});
      },
      async think(system, user, o = {}) {
        const x = await think([{ role: "system", content: system }, { role: "user", content: user }], { model: o.model ?? "deepseek-ai/Deepseek-V4-Flash", maxTokens: o.maxTokens ?? 1500 });
        t.model = `${x.provider === "crusoe" ? "Crusoe" : x.provider} · ${x.model}`;
        return x.text;
      },
    };
    t.status = "running"; t.started = Date.now(); touch(t);
    d.log(`task ${t.taskId} (${t.synth}) running`);
    try {
      t.summary = await Promise.race([e.run(ctx), new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error("took longer than 10 minutes"))))]);
      t.status = "done";
    } catch (err) {
      t.status = "failed"; t.error = String((err as Error)?.message ?? err).slice(0, 300);
    } finally {
      clearTimeout(cap); t.ended = Date.now(); t.line = t.status === "done" ? t.summary : `Failed: ${t.error}`; touch(t); busy.delete(t.synth);
      d.log(`task ${t.taskId} ${t.status}`);
    }
  }

  return { restore, propose, approve, decline, touch, pause: (s: string) => paused.add(s), resume: (s: string) => paused.delete(s), isPaused: (s: string) => paused.has(s), get: (id: string) => tasks.get(id), all: () => [...tasks.values()], executors: () => [...ex.values()] };
}
