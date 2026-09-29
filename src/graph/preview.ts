// Stand-alone preview of the graph view + Crusoe panel before server.ts has the hook:
//   bun src/graph/preview.ts   → http://127.0.0.1:7978/graph, /panel and /wall (everything else, incl. /events, proxies to :7990)
//   /wall?sample=1 uses /frames-sample below until the real /frames is up
import { graphRoutes } from "./routes";

const UP = process.env.UPSTREAM ?? "http://127.0.0.1:7990";
// /frames-sample: a looping stand-in for /frames made of saved headless screenshots (every frame carries sample: true, so
// the wall labels it SAMPLE, never LIVE). WALL_SAMPLE = the folder with manifest.json + the JPEGs.
const SAMPLE = process.env.WALL_SAMPLE ?? `${process.env.HOME}/Genie/scratch/hackday-0929/wall-sample/`;
function sampleFrames(): Response {
  let timer: Timer | undefined;
  const body = new ReadableStream({
    async start(c) {
      const list: { worker: string; file: string; url: string; caption: string; local?: boolean }[] = await Bun.file(SAMPLE + "manifest.json").json().catch(() => []);
      const jpeg = async (f: string) => Buffer.from(await Bun.file(SAMPLE + f).arrayBuffer()).toString("base64");
      const send = (type: string, d: unknown) => { try { c.enqueue(`event: ${type}\ndata: ${JSON.stringify(d)}\n\n`); } catch { clearInterval(timer); } };
      const frame = async (m: (typeof list)[number]) => send("frame", { worker: m.worker, jpeg: await jpeg(m.file), url: m.url, caption: m.caption, local: !!m.local, sample: true, at: Date.now() });
      const firsts = new Map<string, (typeof list)[number]>(); for (const m of list) if (!firsts.has(m.worker)) firsts.set(m.worker, m);
      for (const m of firsts.values()) await frame(m);
      let i = 0, tick = 0;
      timer = setInterval(async () => {
        tick++;
        const m = list[i++ % Math.max(1, list.length)]; if (m) await frame(m);
        if (tick % 40 === 8) send("mark", { worker: "Echo", kind: "block", text: "The draft gives Alex Rivera's availability to George; no transcript line has George suggesting those times.", at: Date.now() });
        if (tick % 40 === 16) send("mark", { worker: "FactCheck", kind: "found", text: "Crusoe and Oracle, 100,000-GPU campus in Abilene", at: Date.now() });
        if (tick % 40 === 22) send("mark", { worker: "Echo", kind: "clear", text: "", at: Date.now() });
        if (tick % 40 === 34) send("mark", { worker: "FactCheck", kind: "clear", text: "", at: Date.now() });
      }, 700);
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}
const PORT = Number(process.env.GRAPH_PREVIEW_PORT ?? 7978);
Bun.serve({
  hostname: "127.0.0.1", port: PORT, idleTimeout: 0,
  async fetch(req) {
    const g = await graphRoutes(req);
    if (g) return g;
    const u = new URL(req.url);
    if (u.pathname === "/frames-sample") return sampleFrames();
    return fetch(UP + u.pathname + u.search, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.arrayBuffer() })
      .catch(() => new Response("upstream down", { status: 502 }));
  },
});
console.log(`graph preview on http://127.0.0.1:${PORT}/graph and /panel (proxying ${UP})`);
