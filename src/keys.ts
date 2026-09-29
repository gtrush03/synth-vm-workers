// Keys come from the macOS Keychain at runtime (or env vars on a VM). They live in memory only: never logged or written.
export type BandCred = { id: string; key: string };
export type Keys = { crusoe?: string; openrouter?: string; brave?: string; resend?: string; neo4j?: string; vultr?: string; band?: Record<string, BandCred> };

async function keychain(service: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const p = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 && out ? out : undefined;
}

export async function loadKeys(): Promise<Keys> {
  const k: Keys = {
    crusoe: process.env.CRUSOE_API_KEY ?? await keychain("hackday-crusoe-api"),
    openrouter: process.env.OPENROUTER_API_KEY ?? await keychain("hackday-openrouter-api"),
    brave: process.env.BRAVE_API_KEY ?? await keychain("hackday-brave-api"),
    resend: process.env.RESEND_API_KEY ?? await keychain("hackday-resend-api"),
    neo4j: process.env.NEO4J_JSON ?? await keychain("hackday-neo4j"),
    vultr: process.env.VULTR_API_KEY ?? await keychain("hackday-vultr-api"),
  };
  const band: Record<string, BandCred> = {};
  const { AGENTS } = await import("./agents");
  for (const [name, a] of Object.entries(AGENTS)) {
    const v = await keychain(a.keychain ?? `hackday-band-agent-${name}`);
    const i = v?.indexOf(":") ?? -1;
    if (v && i > 0) band[name] = { id: v.slice(0, i), key: v.slice(i + 1) };
  }
  // the core five must all be there for a live Band room; specialists are optional extras
  if (["Desk", "Scout", "Echo", "Chief", "FactCheck"].every(n => band[n])) k.band = band;
  return k;
}
