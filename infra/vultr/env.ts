// The env one VM worker gets. The server's runs/worker-spec.json (non-secret, per role: model, recruit list,
// PartnerCheck on OpenRouter) is the source of truth; keys come from the Keychain here and nowhere else.
import { existsSync, readFileSync } from "node:fs";
import type { Keys } from "../../src/keys";
import { AGENTS } from "../../src/agents";

const SPEC_FILE = new URL("../../runs/worker-spec.json", import.meta.url).pathname;
// fallback when the server hasn't written a spec yet (same values as spawnWorker at the time of writing)
const MODELS: Record<string, string> = {
  Scout: "deepseek-ai/Deepseek-V4-Flash", Echo: "openai/gpt-oss-120b", Chief: "deepseek-ai/DeepSeek-V4-Pro", FactCheck: "deepseek-ai/Deepseek-V4-Flash",
  Pricing: "deepseek-ai/Deepseek-V4-Flash", Tech: "deepseek-ai/Deepseek-V4-Flash", Legal: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
  Scheduler: "deepseek-ai/Deepseek-V4-Flash", PartnerCheck: "deepseek-ai/Deepseek-V4-Flash", Counterparty: "openai/gpt-oss-120b",
};

export type VmInfo = { id: string; region: string; host: string };

export function workerEnv(role: string, keys: Keys, vm: VmInfo, server: { url?: string; token?: string }): Record<string, string> {
  const band = keys.band?.[role];
  if (!band) throw new Error(`no Band key for ${role} (Keychain hackday-band-agent-${role})`);
  if (!keys.crusoe) throw new Error("no Crusoe key (Keychain hackday-crusoe-api)");
  const spec: Record<string, string> = existsSync(SPEC_FILE) ? JSON.parse(readFileSync(SPEC_FILE, "utf8"))[role] ?? {} : {};
  const env: Record<string, string> = {
    MOCK: "0", CRUSOE_MODEL: MODELS[role] ?? MODELS.Scout!, ...spec,
    ROLE: role, BAND_AGENT_ID: band.id, BAND_API_KEY: band.key, CRUSOE_API_KEY: keys.crusoe,
    VM_ID: vm.id, VM_REGION: vm.region, VM_HOST: vm.host, WORKSPACE: `/var/lib/synth/${role.toLowerCase()}`,
    SYNTH_FRAMES: "1",   // this worker's own headless Chromium, screencast to the wall
    // ids + handles of every agent (not secret), so mentions resolve on a VM that has no band-agents.json
    AGENTS_JSON: JSON.stringify(Object.fromEntries(Object.entries(AGENTS).map(([n, a]) => [n, { agent_id: a.id, handle: a.handle }]))),
  };
  if (server.url) env.SERVER_URL = server.url;
  if (server.token) env.TELEMETRY_TOKEN = server.token;
  if (keys.openrouter) env.OPENROUTER_API_KEY = keys.openrouter;
  if (keys.brave && role === "Scout") env.BRAVE_API_KEY = keys.brave;
  return env;
}

// systemd EnvironmentFile format; values are single-quoted so nothing is shell-expanded
export const envFile = (env: Record<string, string>) =>
  Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, "")}'`).join("\n") + "\n";
