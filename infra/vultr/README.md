# Vultr VM workers

Each SYNTH worker gets its own Vultr VM: its own computer, disk and headless Chromium. It joins the Band room as one agent.

```bash
bun infra/vultr/vms.ts up Scout Echo Chief Pricing Counterparty   # max 6 VMs in total
bun infra/vultr/vms.ts status [--json]   # role, id, region, IP, VM state + systemd worker state; rewrites runs/vms.json
bun infra/vultr/vms.ts sync              # push the current src/ + env again, restart the workers
bun infra/vultr/vms.ts logs Scout        # last 60 journal lines
bun infra/vultr/vms.ts down              # destroy all (or: down Scout)
```

- **Machine:** `vc2-1c-2gb` (2 GB for Chromium, $0.014/h), Ubuntu 24.04. The regions alternate between sjc and lax. Override with `VM_PLAN` and `VM_REGIONS`.
- **Boot:**
  - `cloud-init.sh` installs bun, Playwright's Chromium and its system libraries, a `synth` user and the `synth-worker` systemd unit. It holds no secrets.
  - Once `/var/lib/synth-ready` exists, `vms.ts` pushes `package.json`, `bun.lock`, `tsconfig.json` and `src/` over SSH.
  - It then writes `/etc/synth/worker.env` (0600) and runs `bun install` and `systemctl restart synth-worker`, which runs `bun src/worker.ts` with `ROLE` from the env file.
- **Keys:**
  - On the mini they come from the Keychain via `src/keys.ts`.
  - On a VM, only that one worker's Band key goes on it, plus Crusoe, OpenRouter, and Brave for Scout. They're sent over SSH stdin, never in argv, user-data, the repo or logs.
  - The SSH key pair lives in `~/Genie/scratch/hackday-0929/vm/`, outside the repo.
  - There's no GitHub token on the VMs.
- **Env:** `env.ts` mirrors `spawnWorker()` in `src/server.ts`: per-role `CRUSOE_MODEL`, Chief's `RECRUITABLE`, PartnerCheck on OpenRouter, plus `VM_ID`, `VM_REGION`, `VM_HOST`, `MOCK=0` and `AGENTS_JSON`.
  - `SERVER_URL` and `TELEMETRY_TOKEN` come from env, or from `runs/public-url.txt` and `runs/telemetry-token.txt`.
- **Limits:**
  - At most 6 VMs.
  - Every VM is tagged `synth-vm-workers` and `until:2026-09-30T03:00:00Z`.
  - The tmux session `vm-reaper` runs `vms.ts reaper` and destroys them all at 03:00Z. It keeps retrying every 60 s for 2 h if the Vultr API is down (it returns 502 during upgrades).
- ⚠ Don't run a role on a VM **and** as a local process: both would answer in Band with the same agent key.
- **Ops Synth's demo VM** (`src/tasks/ops.ts`, role `ops-demo`):
  - one at a time, in sjc;
  - no keys and no SSH key; cloud-init only writes and serves its own status page on :80;
  - it carries the `synth-vm-workers` tag, so the reaper deletes it at 03:00Z and `up` counts it toward the 6 VMs;
  - `status` shows its worker as `n/a`, and `sync` skips it.
