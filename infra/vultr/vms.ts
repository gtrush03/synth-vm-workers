// One Vultr VM per SYNTH worker: its own computer, disk and headless Chromium, joining the Band room as one agent.
//   bun infra/vultr/vms.ts up <Role...>     boot VMs (max 6 in total), push code + that role's keys, start the worker
//   bun infra/vultr/vms.ts status [--json]  VM id, role, region, IP, VM + worker state (always probes: runs/vms.json drives VM_MODE)
//   bun infra/vultr/vms.ts sync [Role...]   re-push the current src/ and env, restart the workers
//   bun infra/vultr/vms.ts logs <Role>      last 60 journal lines of that worker
//   bun infra/vultr/vms.ts down [Role...]   destroy (all, or just those roles)
//   bun infra/vultr/vms.ts reaper [--at 2026-09-30T03:00:00Z]   sleep until the deadline, then destroy all
// Keys: Vultr/Crusoe/Band from the Keychain on the mini. On a VM only /etc/synth/worker.env (0600, root) holds that
// one worker's keys; they travel over SSH stdin, never in argv, user-data or logs.
// SERVER_URL / TELEMETRY_TOKEN: env, else runs/public-url.txt / runs/telemetry-token.txt.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadKeys } from "../../src/keys";
import { envFile, workerEnv } from "./env";

const API = "https://api.vultr.com/v2";
const TAG = "synth-vm-workers";
const EVENT_TAG = "hackday-0929";
const MAX_VMS = 6;
const PLAN = process.env.VM_PLAN ?? "vc2-1c-2gb";   // 2 GB for Chromium; $0.014/h
const REGIONS = (process.env.VM_REGIONS ?? "sjc,lax").split(",");
const OS_ID = 2284;                                  // Ubuntu 24.04 LTS x64
const DEADLINE = "2026-09-30T03:00:00Z";
const DIR = `${process.env.HOME}/Genie/scratch/hackday-0929/vm`;   // SSH key + known_hosts, outside the repo
const SSH_KEY = `${DIR}/id_ed25519`;
const ROOT = new URL("../../", import.meta.url).pathname;
const PUSH = ["package.json", "bun.lock", "tsconfig.json", "src"];

const keys = await loadKeys();
if (!keys.vultr) throw new Error("no Vultr key (Keychain hackday-vultr-api)");

async function vultr(method: string, path: string, body?: unknown): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(API + path, {
      method, headers: { authorization: `Bearer ${keys.vultr}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Vultr answers 502 during its upgrades; retry reads and deletes, never re-POST a create
    if ((r.status === 429 || (r.status >= 500 && method !== "POST")) && i < 5) { await Bun.sleep(1500 * (i + 1)); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`Vultr ${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

// `vm` is Vultr's state; `worker` (systemd, probed over SSH) is the only field that means the role runs there
type Vm = { id: string; role: string; label: string; region: string; ip: string; vm: string; created: string; worker?: string };
const roleOf = (i: any) => (i.tags ?? []).find((t: string) => t.startsWith("role:"))?.slice(5) ?? i.label.replace(/^synth-/, "");

async function list(): Promise<Vm[]> {
  const { instances } = await vultr("GET", "/instances?per_page=100");
  return instances.filter((i: any) => (i.tags ?? []).includes(TAG)).map((i: any) => ({
    id: i.id, role: roleOf(i), label: i.label, region: i.region, ip: i.main_ip,
    vm: `${i.status}/${i.power_status}/${i.server_status}`, created: i.date_created,
  }));
}

async function sshKeyId(): Promise<string> {
  const pub = (await Bun.file(`${SSH_KEY}.pub`).text()).trim();
  const { ssh_keys } = await vultr("GET", "/ssh-keys?per_page=100");
  const found = ssh_keys.find((k: any) => k.ssh_key.trim() === pub);
  if (found) return found.id;
  return (await vultr("POST", "/ssh-keys", { name: TAG, ssh_key: pub })).ssh_key.id;
}

const sshArgs = (ip: string) => ["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${DIR}/known_hosts`, `root@${ip}`];

async function ssh(ip: string, cmd: string, stdin?: string | Uint8Array): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([...sshArgs(ip), cmd], { stdin: stdin === undefined ? "ignore" : new Blob([stdin as BlobPart]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (out + err).trim() };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs: number, everyMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(everyMs);
  }
}

async function serverInfo() {
  const read = async (f: string) => existsSync(`${ROOT}${f}`) ? (await Bun.file(`${ROOT}${f}`).text()).trim() || undefined : undefined;
  const info = { url: process.env.SERVER_URL ?? await read("runs/public-url.txt"), token: process.env.TELEMETRY_TOKEN ?? await read("runs/telemetry-token.txt") };
  if (!info.url || !info.token) console.log(`note: ${!info.url ? "SERVER_URL" : "TELEMETRY_TOKEN"} not set, so workers won't report tiles (they still work in Band)`);
  return info;
}

async function tarball(): Promise<Uint8Array> {
  // COPYFILE_DISABLE: macOS tar would otherwise add AppleDouble ._* files
  const p = Bun.spawn(["tar", "czf", "-", ...PUSH], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const buf = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  if (await p.exited) throw new Error("tar failed: " + await new Response(p.stderr).text());
  return buf;
}

// code + env over SSH, install deps (+ the repo's Playwright browser build if it pins one), (re)start the worker
async function push(vm: Vm, server: { url?: string; token?: string }, tgz: Uint8Array) {
  const env = envFile(workerEnv(vm.role, keys, { id: vm.id, region: vm.region, host: vm.ip }, server));
  let r = await ssh(vm.ip, "rm -rf /opt/synth/src && mkdir -p /opt/synth /var/lib/synth && tar xzf - -C /opt/synth && chown -R synth:synth /opt/synth /var/lib/synth", tgz);
  if (r.code) throw new Error(`${vm.role}: code push failed: ${r.out.slice(-300)}`);
  r = await ssh(vm.ip, "umask 077 && mkdir -p /etc/synth && cat > /etc/synth/worker.env", env);
  if (r.code) throw new Error(`${vm.role}: env push failed`);
  r = await ssh(vm.ip, [
    "cd /opt/synth",
    "su synth -c 'bun install --production' >/dev/null",
    // the browser build that matches the repo's own playwright-core (a cached no-op when it's already there)
    "if [ -f node_modules/playwright-core/cli.js ]; then su synth -c 'cd /opt/synth && node node_modules/playwright-core/cli.js install chromium' >/dev/null; fi",
    "systemctl enable synth-worker >/dev/null 2>&1; systemctl restart synth-worker",
    "sleep 3; systemctl is-active synth-worker",
  ].join(" && "));
  if (r.code) throw new Error(`${vm.role}: start failed: ${r.out.slice(-400)}`);
}

async function writeState(vms: Vm[]) {
  await mkdir(`${ROOT}runs`, { recursive: true });
  await Bun.write(`${ROOT}runs/vms.json`, JSON.stringify({ at: new Date().toISOString(), deadline: DEADLINE, vms }, null, 1));
}

async function up(roles: string[]) {
  if (!roles.length) throw new Error("usage: up <Role...>");
  for (const r of roles) if (!keys.band?.[r]) throw new Error(`no Band key for ${r}`);
  const existing = await list();
  const fresh = roles.filter(r => !existing.some(v => v.role === r));
  if (existing.length + fresh.length > MAX_VMS) throw new Error(`cap: ${existing.length} running + ${fresh.length} new > ${MAX_VMS}`);
  if (Date.now() > Date.parse(DEADLINE)) throw new Error(`past the ${DEADLINE} deadline`);
  const sshkey = await sshKeyId();
  const userData = Buffer.from(await Bun.file(new URL("./cloud-init.sh", import.meta.url)).text()).toString("base64");
  const created: Vm[] = [];
  for (const [n, role] of fresh.entries()) {
    const region = REGIONS[n % REGIONS.length]!;
    const { instance } = await vultr("POST", "/instances", {
      region, plan: PLAN, os_id: OS_ID, label: `synth-${role.toLowerCase()}`, hostname: `synth-${role.toLowerCase()}`,
      tags: [TAG, EVENT_TAG, `role:${role}`, `until:${DEADLINE}`], sshkey_id: [sshkey], user_data: userData, backups: "disabled",
    });
    console.log(`created ${role} ${instance.id} (${region})`);
    created.push({ id: instance.id, role, label: instance.label, region, ip: "", vm: "pending", created: instance.date_created });
  }
  const server = await serverInfo();
  const tgz = await tarball();
  // boot → IP → SSH → cloud-init done (bun + Chromium, ~3–6 min) → push + start, all VMs in parallel
  const targets = [...existing.filter(v => roles.includes(v.role)), ...created];
  const results = await Promise.allSettled(targets.map(async vm => {
    const t0 = Date.now();
    const live = await waitFor(`${vm.role} active`, async () => {
      const { instance: i } = await vultr("GET", `/instances/${vm.id}`);
      return i.status === "active" && i.main_ip !== "0.0.0.0" ? i : undefined;
    }, 10 * 60_000);
    vm.ip = live.main_ip; vm.vm = live.status;
    await waitFor(`${vm.role} cloud-init`, async () => (await ssh(vm.ip, "test -f /var/lib/synth-ready")).code === 0 ? true : undefined, 15 * 60_000, 10_000);
    await push(vm, server, tgz);
    console.log(`${vm.role} worker running on ${vm.ip} (${vm.region}) after ${Math.round((Date.now() - t0) / 1000)} s`);
  }));
  results.forEach((r, i) => r.status === "rejected" && console.log(`FAILED ${targets[i]!.role}: ${String(r.reason).slice(0, 300)}`));
  await status(false, true);
}

async function status(json: boolean, probe: boolean) {
  const vms = await list();
  // only worker VMs run synth-worker; the Ops Synth's demo VM (role ops-demo) has no SSH key and no worker
  const rows = await Promise.all(vms.map(async v => ({ ...v, worker: !keys.band?.[v.role] ? "n/a" : probe && v.ip !== "0.0.0.0" ? (await ssh(v.ip, "systemctl is-active synth-worker")).out.split("\n").pop() || "unknown" : undefined })));
  await writeState(rows);
  if (json) return console.log(JSON.stringify(rows, null, 1));
  if (!rows.length) return console.log("no SYNTH VMs");
  for (const v of rows) console.log([v.role.padEnd(13), v.id, v.region, v.ip.padEnd(15), v.vm, v.worker ?? ""].join("  "));
}

async function sync(roles: string[]) {
  const vms = (await list()).filter(v => keys.band?.[v.role] && (!roles.length || roles.includes(v.role)));
  const server = await serverInfo();
  const tgz = await tarball();
  const res = await Promise.allSettled(vms.map(v => push(v, server, tgz).then(() => console.log(`${v.role}: synced + restarted`))));
  res.forEach((r, i) => r.status === "rejected" && console.log(`FAILED ${vms[i]!.role}: ${String(r.reason).slice(0, 300)}`));
}

async function logs(role: string) {
  const vm = (await list()).find(v => v.role === role);
  if (!vm) throw new Error(`no VM for ${role}`);
  console.log((await ssh(vm.ip, "journalctl -u synth-worker -n 60 --no-pager -o cat")).out);
}

async function down(roles: string[]) {
  const vms = (await list()).filter(v => !roles.length || roles.includes(v.role));
  for (const v of vms) { await vultr("DELETE", `/instances/${v.id}`); console.log(`destroyed ${v.role} ${v.id}`); }
  if (!vms.length) console.log("nothing to destroy");
  await status(false, true);
}

async function reaper(at: string) {
  const ms = Date.parse(at) - Date.now();
  console.log(`reaper: destroying all SYNTH VMs at ${at} (in ${Math.max(0, Math.round(ms / 60000))} min)`);
  if (ms > 0) await Bun.sleep(ms);
  // keep trying for 2 h: a Vultr API outage at 03:00Z must not leave VMs running
  for (let i = 0; i < 120; i++) {
    try { await down([]); if (!(await list()).length) return console.log("reaper: all SYNTH VMs destroyed"); }
    catch (e) { console.log(`reaper: attempt ${i + 1} failed (${String(e).slice(0, 160)}); retrying in 60 s`); }
    await Bun.sleep(60_000);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith("--")));
const args = rest.filter(a => !a.startsWith("--") && !/^\d{4}-/.test(a));
switch (cmd) {
  case "up": await up(args); break;
  case "status": await status(flags.has("--json"), true); break;
  case "sync": await sync(args); break;
  case "logs": await logs(args[0] ?? ""); break;
  case "down": await down(args); break;
  case "reaper": await reaper(rest.includes("--at") ? rest[rest.indexOf("--at") + 1]! : DEADLINE); break;
  default: console.log("usage: bun infra/vultr/vms.ts up <Role...> | status [--json] | sync [Role...] | logs <Role> | down [Role...] | reaper [--at ISO]");
}
