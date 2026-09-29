// Social Synth: drafts ONE post about what the team really did today, with a picture of the live wall. George approves
// the exact text and image (the card's content_sha covers the text). Only then d2's hook posts it from George's X in
// its own browser tab; its screen streams to the wall and the app's Live view. Nothing posts without that yes.
import { mkdir } from "node:fs/promises";
import { makeEye } from "../browser";
import { think } from "../llm";
import type { Executor } from "./types";

const HOOK = `${process.env.HOME}/Genie/scratch/hackday-0929/xpost/xpost.ts`;
const DIR = "runs/social";
const ACCOUNT = () => process.env.SOCIAL_ACCOUNT ?? "trusynth";   // George picked @trusynth (29 Sep 1:36 PT)
const HANDLE = () => ACCOUNT() === "personal" ? "@GTrushevskiy" : "@trusynth";
const clean = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "").replace(/\+?\d[\d\s().-]{7,}\d/g, "").trim();

// what the team really did today, from its own records (never a contact's name or address)
async function today(): Promise<string> {
  const lines: string[] = [];
  try {
    const tasks = JSON.parse(await Bun.file("runs/tasks.json").text()) as any[];
    for (const t of tasks.filter(t => t.status === "done" && t.ended > Date.now() - 86_400_000 && !["social", "finance", "memory"].includes(t.synth))) lines.push(`${t.synthName}: ${t.summary}`);
  } catch {}
  try {
    const runs = JSON.parse(await Bun.file("runs/state.json").text()) as any[];
    const deal = runs.filter(r => r.final?.pass);
    const sent = deal.filter(r => r.sent?.ok && !r.sent?.dry && !r.dry).length;
    if (deal.length) lines.push(`Deal Room: ${deal.length} practice follow-ups (rehearsals, ${sent} actually emailed) drafted by Scout, Echo and Chief in a Band room; Chief blocked unsupported claims; the other company's agent (a second Band account) moved a meeting; nothing sent without George's tap.`);
  } catch {}
  lines.push("Scout, FactCheck, Scheduler and Counterparty each run on their own Vultr computer with their own browser; every Synth thinks on Crusoe models; Neo4j keeps the why; live wall at live.trusynth.com");
  return lines.join("\n");
}

async function wallShot(file: string) {
  // the public (redacted) wall, from a one-off tab in the server's own Chrome
  const eye = makeEye("social-shot", () => {}, { cdp: process.env.CDP_URL ?? "http://127.0.0.1:9377", on: true, server: "", headers: { "x-public": "1" } });
  try {
    await eye.viewport(1600, 900);
    if (!await eye.goto(`http://127.0.0.1:${process.env.PORT ?? 7990}/wall`, "wall")) return false;
    await Bun.sleep(4000);
    const b = await eye.shot(); if (!b) return false;
    await Bun.write(file, Buffer.from(b, "base64"));
    return true;
  } finally { await eye.close(); }
}

const social: Executor = {
  synth: "social", name: "Social Synth", title: "Social lead", kind: "post", sponsors: ["Crusoe", "Vultr"],
  async propose() {
    const facts = await today();
    const x = await think([
      { role: "system", content: "You write one X post for George Trushevskiy, founder of TRU Synth, at a hackathon. The story: a team of AI workers (Synths), each on its own computer with its own browser, did real work today and asked before acting. Pick the 2 most striking true facts; never list costs. Only state what the facts say: rehearsals are practice, not real deals, and never say anything was sent unless the facts say so. 2 or 3 short sentences, at most 200 characters, then the link live.trusynth.com on its own. Plain, confident, first person. No hashtags, no emoji, no em dashes, no names of people or companies he met. Reply with the post text only." },
      { role: "user", content: `What really happened today:\n${facts}` },
    ], { model: "deepseek-ai/Deepseek-V4-Flash", maxTokens: 3000 });
    // whole sentences only: never a post cut mid-word, never a dangling "watch it at ."
    let body = clean(x.text.replace(/^["']|["']$/g, "").replace(/\s*(https?:\/\/)?live\.trusynth\.com\/?\s*/g, " ")).replace(/\s+/g, " ").trim().replace(/\s*[^.!?]*\b(at|on|here)\s*[.:!]?$/i, m => /[a-z]{3,}\s+(at|on|here)\s*[.:!]?$/i.test(m) && !/\w\s*[.!?]$/.test(m.replace(/\s*(at|on|here)\s*[.:!]?$/i, "")) ? "" : m).trim();
    while (body.length > 250 && /[.!?]\s/.test(body)) body = body.slice(0, body.slice(0, -1).search(/[.!?][^.!?]*$/) + 1).trim();
    if (body.length > 250) throw new Error("the draft post was too long");
    if (body.length < 60) throw new Error("the draft post came back empty");
    const text = `${body}\n\nlive.trusynth.com`;
    const shotFile = `${DIR}/wall-${Date.now()}.jpg`;   // one per proposal: the image George approves is the one it posts
    const shotOk = await (async () => { await mkdir(DIR, { recursive: true }); return wallShot(shotFile).catch(() => false); })();
    return {
      task: `Post on X as ${HANDLE()}: one update about today's build`,
      why: shotOk ? "The team's real work today, in one post with a picture of the live wall. Nothing posts until you say yes." : "The team's real work today, in one post. Nothing posts until you say yes.",
      body: text,   // f0's rule: the body IS the exact post text, and content_sha covers exactly it
      input: { text, image: shotOk ? shotFile : "" },
    };
  },
  async run(ctx) {
    // only George's real tap posts: a test tap, an API approval or SOCIAL_DRY=1 types and attaches but never clicks Post
    const text = String(ctx.input.text ?? ""), dry = process.env.SOCIAL_DRY === "1" || ctx.input.dry !== false;
    if (!text || text.length > 280) throw new Error("no post text within 280 characters");
    if (!await Bun.file(HOOK).exists()) throw new Error("the X posting hook is not installed yet");
    await mkdir(`${DIR}/${ctx.taskId}-frames`, { recursive: true });
    await Bun.write(`${DIR}/${ctx.taskId}.txt`, text);
    let image = "";
    if (ctx.input.image && await Bun.file(String(ctx.input.image)).exists()) { image = `${process.cwd()}/${DIR}/${ctx.taskId}.jpg`; await Bun.write(image, Bun.file(String(ctx.input.image))); }
    ctx.proof("result", { title: dry ? "Post (dry run: typed, never posted)" : "Post", lines: [text] });
    ctx.log(`${dry ? "Dry run: " : ""}opening X in its own browser to post as ${HANDLE()}`);
    // real: the approve's ref + its content_sha (the hook re-hashes the text file and refuses on any mismatch)
    const real = !dry && typeof ctx.input.sha === "string" && typeof ctx.input.ref === "string";
    if (!dry && !real) throw new Error("a real post needs the approval's ref and content_sha");
    const args = ["bun", HOOK, "--account", ACCOUNT(), "--approval", real ? String(ctx.input.ref) : ctx.taskId, "--text-file", `${process.cwd()}/${DIR}/${ctx.taskId}.txt`, "--frames-dir", `${process.cwd()}/${DIR}/${ctx.taskId}-frames`, ...(image ? ["--image", image] : []), ...(real ? ["--real", "true", "--content-sha", String(ctx.input.sha)] : ["--dry"])];
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    // its screen, to the wall and the app's Live view, while it works
    let lastM = 0, caption = "Opening X";
    const pump = setInterval(async () => {
      const f = Bun.file(`${DIR}/${ctx.taskId}-frames/latest.jpg`);
      if (!await f.exists() || f.lastModified === lastM) return;
      lastM = f.lastModified;
      ctx.frame(Buffer.from(await f.arrayBuffer()).toString("base64"), caption, "https://x.com");
    }, 700);
    let done: any = null, err = "";
    const dec = new TextDecoder(); let buf = "";
    try {
      for await (const chunk of p.stdout as any) {
        buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j: any; try { j = JSON.parse(line); } catch { continue; }
          if (j.t === "done") done = j; else if (j.t === "error") err = String(j.error ?? "failed");
          const what = j.what ?? j.step ?? (typeof j.t === "string" && !["done", "error"].includes(j.t) ? j.t : "");
          if (what) { caption = String(what).slice(0, 80); ctx.log(String(what)); }
        }
      }
      const code = await p.exited;
      if (code !== 0 || !done) throw new Error(err || `the posting hook exited ${code}`);
    } finally { clearInterval(pump); }
    if (dry) { ctx.log("Dry run finished: typed and attached, Post never clicked"); return "Dry run: the post was typed and attached but not posted."; }
    if (!/^https:\/\/(x|twitter)\.com\//.test(String(done.url ?? ""))) throw new Error("the hook did not return a post URL");
    ctx.proof("id", { label: "X post", value: done.url });
    ctx.proof("source", { title: "The live post on X", url: done.url });
    return `Posted to X: ${done.url}`;
  },
};
export default social;
