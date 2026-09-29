// All worker reasoning goes through here. Crusoe Managed Inference (OpenAI-compatible) first; OpenRouter only if a
// Crusoe call fails. MOCK=1 returns canned text so the whole flow runs with no keys.
export type Msg = { role: "system" | "user" | "assistant"; content: string };
export type LlmResult = { text: string; provider: "crusoe" | "openrouter" | "mock"; model: string; ms: number; tokens: number; inTokens?: number; outTokens?: number; fallbacks?: string[] };

const CRUSOE = "https://api.inference.crusoecloud.com/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";
export const MODEL = process.env.CRUSOE_MODEL || "openai/gpt-oss-120b";
const BACKUP_MODEL = process.env.CRUSOE_BACKUP_MODEL || "openai/gpt-oss-120b";
const FALLBACK_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen3.8-27b:free";   // $0 balance: :free models only
// read per call: the server sets the key after import (Scribe runs in the server process). MOCK=1 is the room only.
const mockLLM = () => process.env.MOCK_LLM === "1" || !process.env.CRUSOE_API_KEY;
export const MOCK_LLM = mockLLM();

async function call(base: string, key: string, model: string, messages: Msg[], maxTokens: number) {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    // gpt-oss thinks less with reasoning_effort=low: same answers for these short jobs, a fraction of the latency
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4, ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}) }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`${base.includes("crusoe") ? "crusoe" : "openrouter"} ${model} ${r.status}`);
  const j: any = await r.json();
  const text = String(j.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error(`${model} empty completion`);
  return { text, tokens: Number(j.usage?.total_tokens ?? 0), inTokens: Number(j.usage?.prompt_tokens ?? 0), outTokens: Number(j.usage?.completion_tokens ?? 0) };
}

export async function think(messages: Msg[], opts: { maxTokens?: number; mock?: () => string; model?: string } = {}): Promise<LlmResult> {
  const MODEL_ = opts.model ?? MODEL;
  const t0 = performance.now();
  const maxTokens = Math.max(opts.maxTokens ?? 0, 3000);   // reasoning models (Kimi, gpt-oss) spend tokens thinking first
  if (mockLLM()) {
    await Bun.sleep(600 + Math.random() * 900);
    const text = opts.mock?.() ?? "ok";
    return { text, provider: "mock", model: `${MODEL_} (mock)`, ms: Math.round(performance.now() - t0), tokens: Math.round(text.length / 4) + 300 };
  }
  // Routing: the worker's own Crusoe model → a second Crusoe model → OpenRouter. Every hop is reported, so the
  // screen shows which provider actually answered.
  const hops: [string, string, string, string][] = [];
  if (process.env.FORCE_FAILOVER !== "1") {
    hops.push(["crusoe", CRUSOE, process.env.CRUSOE_API_KEY!, MODEL_]);
    if (BACKUP_MODEL !== MODEL_) hops.push(["crusoe", CRUSOE, process.env.CRUSOE_API_KEY!, BACKUP_MODEL]);
  }
  if (process.env.OPENROUTER_API_KEY) {
    const or: [string, string, string, string] = ["openrouter", OPENROUTER, process.env.OPENROUTER_API_KEY, FALLBACK_MODEL];
    // FactCheck on stage: a different model family via OpenRouter first, Crusoe behind it
    if (process.env.LLM_PRIMARY === "openrouter") hops.unshift(or); else hops.push(or);
  }
  let last: unknown;
  const fallbacks: string[] = [];
  for (const [provider, base, key, model] of hops) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await call(base, key, model, messages, maxTokens);
        return { ...r, provider: provider as LlmResult["provider"], model, ms: Math.round(performance.now() - t0), fallbacks };
      } catch (e) {
        last = e;
        fallbacks.push(`${provider} ${String(e).replace(/^Error: /, "").slice(0, 80)}`);
        if (!/ 429| 503/.test(String(e))) break;   // rate limit / overload: one quick retry on the same hop
        await Bun.sleep(1200 + Math.random() * 800);
      }
    }
  }
  throw last ?? new Error("no LLM provider configured");
}

// Pull the first JSON object/array out of a model reply (models like to wrap JSON in prose or fences).
export function json<T>(text: string): T | null {
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}
