// Ops Synth: starts ONE demo computer on Vultr in San Jose that serves a status page about itself, opens that page in
// its own browser and leaves proof: VM id, region, IP, page URL, delete time.
// Cap: one ops VM at a time (a second approval shows the running one). It is tagged synth-vm-workers, so the vm-reaper
// (infra/vultr/vms.ts reaper, tmux vm-reaper) destroys it with every other SYNTH VM at 03:00Z = 8 PM PT.
// The VM gets no keys: its cloud-init only writes a page and serves it. Runs on the mini (the Vultr key's ACL is the mini).
import type { Executor, TaskCtx } from "./types";

const API = "https://api.vultr.com/v2";
const DEADLINE = "2026-09-30T03:00:00Z", DELETES_PT = "8:00 PM PT";
const REGION = "sjc", PLAN = "vc2-1c-2gb", OS_ID = 2284, ROLE = "ops-demo";   // Ubuntu 24.04 LTS x64
const TAGS = ["synth-vm-workers", "hackday-0929", `role:${ROLE}`, `until:${DEADLINE}`];
const MAX_EVENT_VMS = 6;

type Vm = { id: string; ip: string; region: string; status: string; created: string; tags: string[] };

async function vultr(ctx: TaskCtx, method: string, path: string, body?: unknown): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(API + path, {
      method, headers: { authorization: `Bearer ${ctx.keys.vultr}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    if ((r.status === 429 || (r.status >= 500 && method !== "POST")) && i < 4) { await Bun.sleep(1500 * (i + 1)); continue; }   // Vultr answers 502 during upgrades; never re-POST a create
    const text = await r.text();
    // Vultr error bodies never echo the key; cut them short anyway
    if (!r.ok) throw new Error(`Vultr ${method} ${path.split("?")[0]} → ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
}
const vmOf = (i: any): Vm => ({ id: i.id, ip: i.main_ip, region: i.region, status: `${i.status}/${i.power_status}/${i.server_status}`, created: i.date_created, tags: i.tags ?? [] });

async function waitFor<T>(ctx: TaskCtx, what: string, fn: () => Promise<T | undefined>, ms: number, every = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    if (ctx.signal.aborted) throw new Error(`stopped at the 10-minute cap while waiting for ${what}`);
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 60000)} min waiting for ${what}`);
    await Bun.sleep(every);
  }
}

// cloud-init: no packages, no secrets. The VM asks its own metadata service who it is, writes the page, serves it on :80.
const USER_DATA = `#!/bin/bash
set -u
mkdir -p /srv/ops
MD=$(curl -fsS --max-time 5 http://169.254.169.254/v1.json || echo '{}')
python3 - "$MD" <<'PY'
import json, sys, datetime, html
try: md = json.loads(sys.argv[1] or "{}")
except Exception: md = {}
now = datetime.datetime.now(datetime.timezone.utc)
pt = now - datetime.timedelta(hours=7)   # PDT on 29 Sep
iid = md.get("instance-v2-id") or md.get("instanceid") or ""
reg = (md.get("region") or {}).get("regioncode", "") if isinstance(md.get("region"), dict) else str(md.get("region") or "")
st = {"service": "TRU Synth Ops Synth", "instance": iid, "region": reg.lower(), "hostname": md.get("hostname", ""),
      "started": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "deletes_at": "${DEADLINE}"}
open("/srv/ops/status.json", "w").write(json.dumps(st))
e = lambda s: html.escape(str(s))
started = pt.strftime("%-I:%M %p PT") + " (" + now.strftime("%H:%MZ") + ")"
open("/srv/ops/index.html", "w").write(f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TRU Synth Ops Synth</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#0b0b0c;color:#ecebe8;font:22px/1.45 -apple-system,Inter,Helvetica,sans-serif;padding:34px 40px}}
.k{{font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#d8c08a}}h1{{font-size:40px;margin:10px 0 22px;font-weight:600}}
.row{{display:flex;gap:18px;padding:9px 0;border-bottom:1px solid #1d1c1b}}.t{{color:#8c8a84;width:190px;flex:none}}.v{{font-variant-numeric:tabular-nums}}
.gold{{color:#d8c08a}}.dot{{display:inline-block;width:12px;height:12px;border-radius:50%;background:#d8c08a;margin-right:10px;animation:p 1.6s infinite}}
@keyframes p{{50%{{opacity:.25}}}}.m{{color:#8c8a84;font-size:16px;margin-top:22px}}
</style></head><body>
<div class="k">TRU Synth · Ops Synth</div>
<h1><span class="dot"></span>Demo computer is up</h1>
<div class="row"><span class="t">Started</span><span class="v">{e(started)}</span></div>
<div class="row"><span class="t">Where</span><span class="v">Vultr {e(reg.upper() or "?")} · vc2-1c-2gb · Ubuntu 24.04</span></div>
<div class="row"><span class="t">Instance</span><span class="v">{e(iid or "not reported")}</span></div>
<div class="row"><span class="t">Up for</span><span class="v" id="up">–</span></div>
<div class="row"><span class="t">Auto-deletes</span><span class="v gold">${DELETES_PT} (03:00Z) · <span id="left">–</span></span></div>
<p class="m">This page is served by the computer itself. Started by Ops Synth; the SYNTH VM reaper deletes it at ${DELETES_PT}.</p>
<script>
const s=Date.parse("{st['started']}"),d=Date.parse("${DEADLINE}");
const f=ms=>{{ms=Math.max(0,ms);const h=Math.floor(ms/36e5),m=Math.floor(ms%36e5/6e4),x=Math.floor(ms%6e4/1e3);return (h?h+" h ":"")+m+" m "+x+" s"}};
setInterval(()=>{{up.textContent=f(Date.now()-s);left.textContent="in "+f(d-Date.now())}},1000);
</script></body></html>""")
PY
ufw allow 80/tcp >/dev/null 2>&1 || true
cat > /etc/systemd/system/ops-page.service <<'UNIT'
[Unit]
Description=Ops Synth status page
After=network-online.target
[Service]
WorkingDirectory=/srv/ops
ExecStart=/usr/bin/python3 -m http.server 80 --bind 0.0.0.0
DynamicUser=yes
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ops-page
`;

// the Synth's own progress view while the VM boots (black + champagne, like the other local views)
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const progress = (steps: { text: string; done: boolean }[]) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#0b0b0c;color:#ecebe8;font:24px/1.5 -apple-system,Inter,Helvetica,sans-serif;padding:30px 36px}
h1{font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:#d8c08a;margin:0 0 18px;font-weight:600}
.s{display:flex;gap:16px;padding:10px 0;border-bottom:1px solid #1d1c1b}.b{width:90px;flex:none;color:#8c8a84;font-size:16px;padding-top:4px;letter-spacing:.08em}
.ok{color:#d8c08a}</style></head><body><h1>Ops Synth · demo computer</h1>
${steps.map((s, i) => `<div class="s"><span class="b ${s.done ? "ok" : ""}">${s.done ? "DONE" : i === steps.length - 1 ? "NOW" : ""}</span><span>${esc(s.text)}</span></div>`).join("")}</body></html>`;

const ops: Executor = {
  synth: "ops", name: "Ops Synth", title: "Ops lead", kind: "vm", sponsors: ["Vultr"],
  propose() {
    return { task: "Start a demo computer in San Jose for tonight (auto-deletes 8 PM PT)", why: "A live machine judges can open, made by a Synth in about two minutes and gone after the event." };
  },
  async run(ctx) {
    if (!ctx.keys.vultr) throw new Error("no Vultr key (Keychain hackday-vultr-api)");
    if (Date.now() > Date.parse(DEADLINE) - 15 * 60_000) throw new Error(`too close to the ${DELETES_PT} teardown to start a new computer`);
    const steps: { text: string; done: boolean }[] = [];
    const step = async (text: string, done = false) => { steps.push({ text, done }); ctx.log(text); await ctx.page.view("ops", progress(steps), "Ops Synth · starting a demo computer"); };
    const t0 = Date.now();

    await step("Checking what's already running on Vultr");
    const all = ((await vultr(ctx, "GET", "/instances?per_page=100")).instances ?? []).map(vmOf) as Vm[];
    const event = all.filter(v => v.tags.includes("hackday-0929") || v.tags.includes("synth-vm-workers"));
    let vm = event.find(v => v.tags.includes(`role:${ROLE}`));
    let created = false;
    if (vm) {
      steps.at(-1)!.done = true;
      await step(`One demo computer is already running (cap: one at a time), so Ops Synth shows it instead of starting another`, true);
    } else {
      if (event.length >= MAX_EVENT_VMS) throw new Error(`cap: ${event.length} of ${MAX_EVENT_VMS} event VMs are already running`);
      steps.at(-1)!.done = true;
      await step(`Creating a ${PLAN} in ${REGION.toUpperCase()} (San Jose) with a status page`);
      const { instance } = await vultr(ctx, "POST", "/instances", {
        region: REGION, plan: PLAN, os_id: OS_ID, label: "synth-ops-demo", hostname: "ops-demo", tags: TAGS,
        user_data: Buffer.from(USER_DATA).toString("base64"), backups: "disabled",
      });
      vm = vmOf(instance); created = true;
      steps.at(-1)!.done = true;
      await step(`Vultr accepted it: instance ${vm.id.slice(0, 8)}…`, true);
    }
    ctx.proof("id", { label: "Vultr instance", value: vm.id });
    ctx.proof("id", { label: "Region", value: `${vm.region} (San Jose)` });

    try {
      if (!vm.ip || vm.ip === "0.0.0.0" || !vm.status.startsWith("active")) {
        await step("Waiting for Vultr to boot it and give it an IP");
        vm = await waitFor(ctx, "the VM to become active", async () => {
          const v = vmOf((await vultr(ctx, "GET", `/instances/${vm!.id}`)).instance);
          return v.status.startsWith("active") && v.ip !== "0.0.0.0" ? v : undefined;
        }, 5 * 60_000);
        steps.at(-1)!.done = true;
      }
      const url = `http://${vm.ip}/`;
      await step(`Waiting for it to serve its own page at ${url}`);
      const st = await waitFor(ctx, "the status page", async () => {
        const r = await fetch(`${url}status.json`, { signal: AbortSignal.timeout(4000) });
        return r.ok ? await r.json() as { instance?: string; region?: string; started?: string } : undefined;
      }, 6 * 60_000);
      steps.at(-1)!.done = true;
      const secs = Math.round((Date.now() - t0) / 1000);
      const same = st.instance === vm.id;

      await ctx.page.goto(url, "Ops Synth · the demo computer's own status page");
      await ctx.page.highlight("Auto-deletes 8:00 PM PT");
      await ctx.shot(`The status page, served by instance ${vm.id.slice(0, 8)} itself`);

      const plan = ((await vultr(ctx, "GET", "/plans?type=vc2&per_page=500").catch(() => ({ plans: [] }))).plans ?? []).find((p: any) => p.id === PLAN);
      ctx.proof("id", { label: "IP", value: vm.ip });
      ctx.proof("source", { title: "Status page on the demo computer", url });
      ctx.proof("id", { label: "Deletes at", value: `${DELETES_PT} (2026-09-30 03:00Z), by the SYNTH VM reaper` });
      if (created) ctx.proof("number", { label: "Ready in", value: secs, unit: "s", from: "timed from the Vultr create call to the page answering" });
      if (plan?.hourly_cost != null) ctx.proof("number", { label: "Price", value: plan.hourly_cost, unit: "$/h", from: `Vultr /v2/plans (${PLAN})` });
      ctx.proof("result", {
        title: created ? "Demo computer started" : "Demo computer already running",
        lines: [
          `Instance ${vm.id} in ${vm.region} (San Jose), ${PLAN}, Ubuntu 24.04`,
          `Page ${url}, started ${st.started ?? "?"} by the VM's clock`,
          same ? "The page reports the same instance id Vultr gave us" : `The page reports instance "${st.instance || "none"}", which does not match`,
          `Auto-deletes ${DELETES_PT} (03:00Z)`,
        ],
        url,
      });
      return `${created ? "Demo computer up" : "Demo computer already up"} in San Jose: ${vm.id.slice(0, 8)} at ${vm.ip}${created ? ` in ${secs} s` : ""}, page live, auto-deletes ${DELETES_PT}.`;
    } catch (e) {
      // a computer we just made that never came up is deleted now, not left for the reaper
      if (created) {
        await vultr(ctx, "DELETE", `/instances/${vm.id}`).then(
          () => ctx.log(`Deleted instance ${vm!.id.slice(0, 8)} because it did not come up`),
          () => ctx.log(`Could not delete instance ${vm!.id.slice(0, 8)}; the reaper removes it at ${DELETES_PT}`));
      }
      throw e;
    }
  },
};
export default ops;
