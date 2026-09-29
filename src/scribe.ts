// Desk's first job when a conversation lands (the trip-wire): split the transcript into evidence lines and pull out
// what matters on Crusoe. Lines become sources (ids 100+) that Chief can hold every claim against.
import { think, json } from "./llm";
import type { Line, Scribe } from "./roles";

// Accepts Plaud CLI text, "Speaker 1 [0:12]: …", "[00:12] Name: …", "Name (0:12): …" or plain "Name: …".
export function parseTranscript(raw: string): Line[] {
  const out: Line[] = [];
  let n = 0;
  for (const row of raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    const ts = row.match(/\[?\(?(\d{1,2}:\d{2}(?::\d{2})?)\)?\]?/);
    const rest = row.replace(/^\s*\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?\s*[-–]?\s*/, "");
    const m = rest.match(/^([^:]{1,40}?)\s*(?:\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?)?\s*:\s*(.+)$/);
    const speaker = m ? m[1]!.trim() : out.at(-1)?.speaker ?? "Speaker";
    const text = (m ? m[2]! : rest).trim();
    if (!text) continue;
    if (!m && out.length && !ts) { out.at(-1)!.text += ` ${text}`; continue; }   // wrapped line
    n++;
    out.push({ id: n, speaker, t: ts?.[1] ?? `${Math.floor((n - 1) * 5 / 60)}:${String(((n - 1) * 5) % 60).padStart(2, "0")}`, text: text.slice(0, 400) });
  }
  return out.slice(0, 60);
}

export async function scribe(lines: Line[], ctx: { who?: string; company: string }) {
  const text = lines.map(l => `[${100 + l.id}] ${l.t} ${l.speaker}: ${l.text}`).join("\n");
  const r = await think([
    { role: "system", content: "You are Scribe. Extract only what was actually said. Reply with JSON only." },
    { role: "user", content: `Conversation between George (TRU Synth) and ${ctx.who ?? "a contact"} from ${ctx.company}:\n${text}\n\nReturn {"summary": "one sentence", "topic": "2-5 words", "needs": ["what they need, their words"], "commitments": [{"text": "...", "owner": "George|<them>", "due": "when, if said", "line": <line id>}], "quote": {"line": <id>, "text": "one short line worth quoting back"}, "flags": {"pricing": bool, "tech": bool, "legal": bool, "meeting": bool}}` },
  ], { model: process.env.SCRIBE_MODEL ?? "deepseek-ai/Deepseek-V4-Flash", maxTokens: 800, mock: () => JSON.stringify({
    summary: `George met ${ctx.who ?? "them"} from ${ctx.company}.`, topic: "AI workers", needs: ["agents they can trust"],
    commitments: [{ text: "send a follow-up with a call time", owner: "George", due: "this week", line: 100 + (lines.at(-1)?.id ?? 1) }],
    quote: { line: 100 + (lines[0]?.id ?? 1), text: lines[0]?.text ?? "" }, flags: { meeting: /meet|call|next week|tuesday|friday/i.test(text), pricing: /price|cost|\$/i.test(text) } }) });
  const s = json<Scribe>(r.text);
  const out: Scribe = { summary: s?.summary ?? "", topic: s?.topic ?? "our conversation", needs: s?.needs ?? [], commitments: s?.commitments ?? [], quote: s?.quote, flags: s?.flags ?? {} };
  return { scribe: out, llm: r };
}
