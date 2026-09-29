// API smoke test: start a DRY run, wait for awaiting_approval, approve → status sent (dry: nothing is emailed).
const base = process.env.BASE ?? "http://localhost:7990";
const p = Bun.spawn(["security", "find-generic-password", "-s", "hackday-dealroom-token", "-w"], { stdout: "pipe" });
const H = { authorization: `Bearer ${(await new Response(p.stdout).text()).trim()}`, "content-type": "application/json" };
const t0 = Date.now();
console.log("unauth:", (await fetch(`${base}/api/run/x`)).status);
let s: any = await (await fetch(`${base}/api/run`, { method: "POST", headers: H, body: JSON.stringify({ who: "Alex Rivera", company: process.argv[2] ?? "Northwind Labs", email: "hello+demo@trusynth.com", ask: "Follow up on our chat and set a call next week", dry: true,
  transcript: process.env.NO_TRANSCRIPT ? undefined : await Bun.file(import.meta.dir + "/transcript-rehearsal.txt").text(), transcriptVia: "Plaud (pasted)" }) })).json();
console.log("start:", JSON.stringify(s));
const id = s.runId;
while (Date.now() - t0 < 240_000) { s = await (await fetch(`${base}/api/run/${id}`, { headers: H })).json(); if (s.status !== "running") break; await Bun.sleep(2000); }
console.log(`after ${((Date.now() - t0) / 1000).toFixed(0)} s:`, s.status, "|", s.summary);
if (s.status === "awaiting_approval") console.log("approve:", JSON.stringify(await (await fetch(`${base}/api/run/${id}/approve`, { method: "POST", headers: H })).json()).slice(0, 300));
