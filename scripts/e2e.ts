// e2e: start a run, wait for the approval card, approve, fetch the shipped page. Never prints the admin key.
const base = process.env.BASE ?? "http://localhost:7990";
const k = new URL((await Bun.file("runs/admin-url.txt").text()).trim()).searchParams.get("k");
const company = process.argv[2] ?? "Vultr";
const t0 = Date.now();
let r: any;
for (let i = 0; i < 30; i++) { const x = await fetch(`${base}/run`, { method: "POST", body: JSON.stringify({ company, email: process.env.EMAIL, k }) }); r = await x.json(); if (x.status !== 503) break; console.log("waiting:", r.error); await Bun.sleep(3000); }
console.log("run", r.id, r.roomId);
let s: any;
for (let i = 0; i < 240; i++) {
  s = await (await fetch(`${base}/state`)).json();
  if (s.run?.status !== "running") break;
  await Bun.sleep(1000);
}
for (const l of s.run.lines) console.log(`+${((l.at - t0) / 1000).toFixed(1)}s ${l.from.padEnd(9)} [${l.kind}${l.tone ? "/" + l.tone : ""}] ${l.text.replace(/\n/g, " ⏎ ").slice(0, 170)}`);
console.log("status", s.run.status, "meter", JSON.stringify({ calls: s.meter.calls, tokens: s.meter.tokens, avg: Math.round(s.meter.ms / (s.meter.calls || 1)), prov: s.meter.byProvider }));
if (s.run.status === "awaiting approval" && process.env.APPROVE !== "0") {
  const a: any = await (await fetch(`${base}/approve`, { method: "POST", body: JSON.stringify({ runId: s.run.id, yes: true, k }) })).json();
  const p = await fetch(base + a.shipped);
  console.log("approved →", a.shipped, p.status, (await p.text()).match(/<h1>(.*?)<\/h1>/)?.[1]);
}
console.log("total", ((Date.now() - t0) / 1000).toFixed(1), "s");
