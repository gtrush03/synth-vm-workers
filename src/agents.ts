// Band identities (ids and handles are not secret; keys live in the Keychain / VM env only).
// Built-ins, plus any agent registered later in hack-accounts' band-agents.json (or AGENTS_JSON on a VM).
import { existsSync, readFileSync } from "node:fs";

export const AGENTS: Record<string, { id: string; handle: string; keychain?: string }> = {
  Desk: { id: "0f493f65-02c4-41d3-9137-acd34648b131", handle: "hello3/desk" },
  Scout: { id: "853dfe75-eeff-4058-b80e-8a7856babcfa", handle: "hello3/scout" },
  Echo: { id: "0a69077e-b271-42c9-8db1-ba8a645df967", handle: "hello3/echo" },
  Chief: { id: "23a42fb3-de1b-4a8d-82de-c9906d81f7ba", handle: "hello3/chief" },
  FactCheck: { id: "e2dee5ec-3070-4bbf-bbc2-e140c6cd5f5c", handle: "hello3/factcheck" },
  // FactCheck on a SECOND Band account ("TRU Synth Partner"), reachable only through a contact: the boundary signal
  PartnerCheck: { id: "56817219-317a-45a0-b506-12efd71409b0", handle: "hellobandpartner/factcheck", keychain: "hackday-band-agent-FactCheck-partner" },
};
const RENAME: Record<string, string> = { "FactCheck-partner": "PartnerCheck" };
try {
  const f = process.env.AGENTS_FILE ?? `${process.env.HOME}/Genie/scratch/hackday-0929/band-agents.json`;
  const extra = process.env.AGENTS_JSON ? JSON.parse(process.env.AGENTS_JSON) : existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  for (const [k, v] of Object.entries<any>(extra)) {
    if (k.startsWith("_") || !v?.agent_id && !v?.id) continue;
    const name = RENAME[k] ?? k;
    AGENTS[name] ??= { id: v.agent_id ?? v.id, handle: v.handle, keychain: v.keychain };
  }
} catch {}

export const GEORGE = { id: "a0c198eb-8119-4279-bf09-e6d160ad22aa", handle: "hello3" };
export const nameOf = (idOrName: string) => Object.entries(AGENTS).find(([n, a]) => a.id === idOrName || a.handle === idOrName || n.toLowerCase() === String(idOrName).toLowerCase())?.[0] ?? idOrName;
export const mentionRefs = (names: string[]) => names.map(n => AGENTS[n] ? { id: AGENTS[n].id, name: n, handle: AGENTS[n].handle } : { id: n, name: n });
