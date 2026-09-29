// A populated /graph for the film: a 1920x1080 still plus a short screencast that pans, then selects a claim to show
// its evidence path. Uses a tab in the server's own headless Chrome (never a second browser).
//   bun scripts/graphshot.ts <shoot> [--run <id>] [--secs 15] [--base https://live.trusynth.com]
// Output: ~/Genie/scratch/hackday-0929/video/captures/<shoot>/{pages/graph-full.jpg, pages/graph-claim.jpg, graph.mp4}
import { mkdir } from "node:fs/promises";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const shoot = process.argv[2]?.replace(/[^\w.-]/g, "") || "graph";
const BASE = arg("base", "https://live.trusynth.com"), CDP = arg("cdp", "http://127.0.0.1:9377"), SECS = Number(arg("secs", "15"));
const run = arg("run", "");
const OUT = `${process.env.HOME}/Genie/scratch/hackday-0929/video/captures/${shoot}`;
await mkdir(`${OUT}/pages`, { recursive: true }); await mkdir(`${OUT}/graph`, { recursive: true });
const url = `${BASE}/graph${run ? `?run=${encodeURIComponent(run)}` : "?rehearsals=1"}`;

const target = await (await fetch(`${CDP}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json() as any;
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const waits = new Map<number, (r: any) => void>();
const send = (method: string, params: any = {}) => new Promise<any>(res => { const n = ++id; waits.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const frames: { file: string; t: number }[] = []; let recording = false, last = 0; const T0 = Date.now();
ws.onmessage = async e => {
  const m = JSON.parse(String(e.data));
  if (m.id && waits.has(m.id)) { waits.get(m.id)!(m.result ?? m.error); waits.delete(m.id); return; }
  if (m.method === "Page.screencastFrame") {
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
    const now = Date.now(); if (!recording || now - last < 66) return;   // ≤15 fps
    last = now; const file = `graph/${now - T0}.jpg`;
    await Bun.write(`${OUT}/${file}`, Buffer.from(m.params.data, "base64")); frames.push({ file, t: now });
  }
};
await new Promise(r => ws.onopen = r);
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.navigate", { url });
await Bun.sleep(7000);   // let the force layout settle
const still = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 90 }); await Bun.write(`${OUT}/pages/${name}`, Buffer.from(r.data, "base64")); };
await still("graph-full.jpg");
const count = await send("Runtime.evaluate", { expression: `[...document.querySelectorAll("#g *")].filter(n => n.__data__?.label === "Claim").length`, returnByValue: true });
console.log(`graph ${url}: ${count?.result?.value ?? 0} claim nodes`);

// screencast: a slow pan (drag), then select a claim so its evidence path lights up
recording = true;
await send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
const mouse = (type: string, x: number, y: number, buttons = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: buttons ? "left" : "none", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
const panSecs = Math.max(3, SECS * 0.35);
await mouse("mousePressed", 900, 540, 1);
for (let i = 1; i <= 40; i++) { await mouse("mouseMoved", 900 + i * 3, 540 + Math.sin(i / 6) * 25, 1); await Bun.sleep(panSecs * 1000 / 40); }
await mouse("mouseReleased", 1020, 540, 1);
await Bun.sleep(800);
// hover then click the claim with the most edges (the one the checker sourced)
const pos = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  const ns = [...document.querySelectorAll("#g *")].filter(n => n.__data__?.label === "Claim");
  if (!ns.length) return null;
  const n = ns.find(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.x > 300 && r.x < 1500 && r.y > 300 && r.y < 800; }) ?? ns[0];
  window.__pick = n; const b = n.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
})()` });
const p = pos?.result?.value;
if (p) {
  for (let i = 1; i <= 20; i++) { await mouse("mouseMoved", 1020 + (p.x - 1020) * i / 20, 540 + (p.y - 540) * i / 20); await Bun.sleep(40); }
  await Bun.sleep(500);
  await send("Runtime.evaluate", { expression: `window.__pick.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: ${p.x}, clientY: ${p.y} }))` });
}
await Bun.sleep(Math.max(3000, SECS * 1000 - (Date.now() - T0 - 7000)));
recording = false;
await send("Page.stopScreencast");
await still("graph-claim.jpg");
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});

if (frames.length > 1) {
  const list = frames.map((f, i) => `file '${OUT}/${f.file}'\nduration ${(((frames[i + 1]?.t ?? f.t + 1000) - f.t) / 1000).toFixed(3)}`).join("\n") + `\nfile '${OUT}/${frames.at(-1)!.file}'\n`;
  await Bun.write(`${OUT}/graph.txt`, list);
  await Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${OUT}/graph.txt`, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "20", `${OUT}/graph.mp4`], { stdout: "inherit", stderr: "inherit" }).exited;
}
console.log(`done: ${frames.length} frames, clicked claim: ${p ? "yes" : "no"} → ${OUT}`);
process.exit(0);
