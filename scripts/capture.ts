// Record a demo run for the video: the /wall at 1920x1080 (a tab in the server's own headless Chrome, never a
// second browser), every tile's raw frames with timestamps, and a beat timeline. Stops on Ctrl-C or after --secs.
//   bun scripts/capture.ts <run-name> [--secs 600] [--base http://127.0.0.1:7990] [--cdp http://127.0.0.1:9377]
// Output: ~/Genie/scratch/hackday-0929/video/captures/<run>/{wall/*.jpg, wall.mp4, tiles/<worker>/*.jpg, tiles/<worker>.mp4, tiles.jsonl, timeline.json}
import { mkdir } from "node:fs/promises";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const run = process.argv[2]?.replace(/[^\w.-]/g, "") || new Date().toISOString().slice(11, 19).replace(/:/g, "");
const BASE = arg("base", "http://127.0.0.1:7990"), CDP = arg("cdp", "http://127.0.0.1:9377"), SECS = Number(arg("secs", "900"));
const OUT = `${process.env.HOME}/Genie/scratch/hackday-0929/video/captures/${run}`;
await mkdir(`${OUT}/wall`, { recursive: true }); await mkdir(`${OUT}/tiles`, { recursive: true });
const T0 = Date.now();
// --build: only rebuild the mp4s (and a timeline from tiles.jsonl) from frames already on disk, e.g. after a crash
if (process.argv.includes("--build")) {
  const { readdir } = await import("node:fs/promises");
  const frames = async (sub: string) => (await readdir(`${OUT}/${sub}`).catch(() => [] as string[])).filter(f => f.endsWith(".jpg")).map(f => ({ file: `${sub}/${f}`, t: Number(f.slice(0, -4)) })).sort((a, b) => a.t - b.t);
  const mk = async (fr: { file: string; t: number }[], out: string) => {
    if (fr.length < 2) return;
    await Bun.write(`${out}.txt`, fr.map((f, i) => `file '${OUT}/${f.file}'\nduration ${(((fr[i + 1]?.t ?? f.t + 1000) - f.t) / 1000).toFixed(3)}`).join("\n") + `\nfile '${OUT}/${fr.at(-1)!.file}'\n`);
    await Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${out}.txt`, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "20", `${out}.mp4`], { stdout: "inherit", stderr: "inherit" }).exited;
  };
  await mk(await frames("wall"), `${OUT}/wall`);
  for (const w of await readdir(`${OUT}/tiles`).catch(() => [] as string[])) if (!w.includes(".")) await mk(await frames(`tiles/${w}`), `${OUT}/tiles/${w}`);
  if (!await Bun.file(`${OUT}/timeline.json`).exists()) {
    const beats: any[] = []; const last: Record<string, string> = {};
    for (const l of (await Bun.file(`${OUT}/tiles.jsonl`).text().catch(() => "")).split("\n").filter(Boolean)) { const j = JSON.parse(l); if (j.caption && j.caption !== last[j.worker]) { last[j.worker] = j.caption; beats.push({ t: j.t, synth: j.worker, step: j.caption, url: j.url, kind: "browser" }); } }
    await Bun.write(`${OUT}/timeline.json`, JSON.stringify({ run, rebuilt: "from tiles.jsonl (the capture was stopped hard)", beats }, null, 1));
  }
  console.log(`rebuilt ${OUT}`); process.exit(0);
}
const timeline: { t: number; at: string; synth: string; step: string; url?: string; kind?: string }[] = [];
const beat = (synth: string, step: string, extra: { url?: string; kind?: string } = {}) => timeline.push({ t: +((Date.now() - T0) / 1000).toFixed(2), at: new Date().toISOString(), synth, step: step.replace(/\s+/g, " ").slice(0, 300), ...extra });
let stopping = false;

// ---- 1. the wall, screencast from a tab in the shared Chrome ----
const target = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`${BASE}/wall`)}`, { method: "PUT" })).json() as any;
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const send = (method: string, params: any = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
const wallFrames: { file: string; t: number }[] = [];
let lastWall = 0;
ws.onmessage = async e => {
  const m = JSON.parse(String(e.data));
  if (m.method === "Page.screencastFrame") {
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
    const now = Date.now(); if (now - lastWall < 100) return;   // ≤10 fps
    lastWall = now;
    const file = `wall/${now - T0}.jpg`;
    await Bun.write(`${OUT}/${file}`, Buffer.from(m.params.data, "base64"));
    wallFrames.push({ file, t: now });
  }
};
await new Promise(r => ws.onopen = r);
send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
send("Page.enable");
send("Page.navigate", { url: `${BASE}/wall` });
await Bun.sleep(1500);
send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
// a still every second as well, so a quiet wall still has frames
const still = setInterval(() => { if (Date.now() - lastWall > 900) send("Page.captureScreenshot", { format: "jpeg", quality: 75 }); }, 1000);
const origOnMessage = ws.onmessage;
ws.onmessage = async e => {
  const m = JSON.parse(String(e.data));
  if (m.result?.data && !m.method) { const now = Date.now(); lastWall = now; const file = `wall/${now - T0}.jpg`; await Bun.write(`${OUT}/${file}`, Buffer.from(m.result.data, "base64")); wallFrames.push({ file, t: now }); return; }
  (origOnMessage as any)(e);
};

// ---- 2. SSE readers: raw tile frames + room/task events ----
async function sse(path: string, on: (ev: string, data: any) => void) {
  const r = await fetch(`${BASE}${path}`); const rd = r.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  while (!stopping) {
    const { value, done } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (ev && data) try { on(ev, JSON.parse(data)); } catch {}
    }
  }
}
const tileFrames: Record<string, { file: string; t: number }[]> = {};
const tilesLog = Bun.file(`${OUT}/tiles.jsonl`).writer();
const lastCaption: Record<string, string> = {};
sse("/frames", async (ev, f) => {
  if (ev === "mark") { beat(f.worker, `${f.kind.toUpperCase()}${f.text ? `: ${f.text}` : ""}`, { kind: f.kind }); return; }
  if (ev !== "frame" || !f.jpeg) return;
  if (f.idle && Date.now() - (tileFrames[f.worker]?.at(-1)?.t ?? 0) < 3000) return;   // idle stills: one per 3 s is plenty
  const now = Date.now(), file = `tiles/${f.worker}/${now - T0}.jpg`;
  await mkdir(`${OUT}/tiles/${f.worker}`, { recursive: true });
  await Bun.write(`${OUT}/${file}`, Buffer.from(f.jpeg, "base64"));
  (tileFrames[f.worker] ??= []).push({ file, t: now });
  tilesLog.write(JSON.stringify({ t: +((now - T0) / 1000).toFixed(2), worker: f.worker, url: f.url, caption: f.caption, file }) + "\n");
  if (f.caption && f.caption !== lastCaption[f.worker] && !f.idle) { lastCaption[f.worker] = f.caption; beat(f.worker, f.caption, { url: f.url, kind: "browser" }); }
});
const seenTask: Record<string, number> = {};
sse("/events", (ev, d) => {
  if (ev === "line" && d.kind !== "llm") beat(d.from, d.text, { kind: d.tone === "veto" ? "block" : d.tone === "pass" ? "pass" : d.kind });
  if (ev === "run") beat("Desk", `run ${d.id} ${d.status}${d.sent?.id ? ` (Resend ${d.sent.id})` : ""}`, { kind: "run" });
  if (ev === "task") {
    const n = seenTask[d.taskId] ?? 0;
    for (const p of d.proofs.slice(n)) if (p.kind === "step" || p.kind === "id" || p.kind === "result") beat(d.synth, p.data.text ?? `${p.data.label ?? p.data.title}: ${p.data.value ?? (p.data.lines ?? []).join("; ")}`, { url: p.data.url, kind: p.kind });
    seenTask[d.taskId] = d.proofs.length;
    if (d.status === "done" || d.status === "failed") beat(d.synth, `task ${d.status}: ${d.summary ?? d.error ?? ""}`, { kind: "task" });
  }
});
beat("capture", `recording ${BASE}/wall at 1920x1080`, { kind: "start" });
console.log(`capturing to ${OUT} (Ctrl-C to stop, max ${SECS}s)`);

// ---- 3. stop: close the tab, write the timeline, build the videos ----
async function video(frames: { file: string; t: number }[], out: string) {
  if (frames.length < 2) return;
  const list = frames.map((f, i) => `file '${OUT}/${f.file}'\nduration ${(((frames[i + 1]?.t ?? f.t + 1000) - f.t) / 1000).toFixed(3)}`).join("\n") + `\nfile '${OUT}/${frames.at(-1)!.file}'\n`;
  await Bun.write(`${out}.txt`, list);
  const p = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${out}.txt`, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "20", `${out}.mp4`], { stdout: "inherit", stderr: "inherit" });
  await p.exited;
}
async function stop() {
  if (stopping) return; stopping = true;
  clearInterval(still);
  try { send("Page.stopScreencast"); } catch {}
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
  beat("capture", "stopped", { kind: "stop" });
  await Bun.write(`${OUT}/timeline.json`, JSON.stringify({ run, started: new Date(T0).toISOString(), beats: timeline }, null, 1));
  tilesLog.end();
  console.log(`building videos (${wallFrames.length} wall frames, ${Object.keys(tileFrames).length} tiles)`);
  await video(wallFrames, `${OUT}/wall`);
  for (const [w, fr] of Object.entries(tileFrames)) await video(fr, `${OUT}/tiles/${w}`);
  console.log(`done: ${OUT}`);
  process.exit(0);
}
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setTimeout(stop, SECS * 1000);
