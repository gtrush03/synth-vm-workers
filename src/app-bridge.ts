// Deal Synth in George's TRU Synth app (DEAL-SYNTH-CONTRACT.md §2). The staging Worker can't reach us, so we push
// the whole doc on every change and poll its inbox for George's taps and chat. Inert without a Deal token.
import { createHash } from "node:crypto";

const BASE = process.env.DEAL_BASE ?? "https://app-staging.trusynth.com";
type RunLike = { id: string; company: string; who?: string; to?: string; status: string; started: number; ended?: number; final?: any; sent?: any; dry?: boolean; decision?: string };
export type BridgeDeps = {
  current(): RunLike | null;
  run(id: string): RunLike | undefined;
  decide(r: RunLike, yes: boolean): Promise<void>;
  chat(text: string): Promise<string>;
  helpers(): string;   // one live line: who is in the room doing what
  notes?(): string;    // plain sentences for the app's Ask answer (under 4 KB)
  team?(): any[];      // TEAM cards (team-*), each {card, approvals, running, notes, proof}
  teamInbox?(row: any): Promise<{ status: string; text?: string; error?: string }>;
  log(text: string): void;
};

const iso = (t = Date.now()) => new Date(t).toISOString();
const pt = (t = Date.now()) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
const clean = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

export function startBridge(token: string | undefined, d: BridgeDeps) {
  if (!token) { d.log("app bridge off: no Deal token"); return { changed() {} }; }
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const stats = { day: new Date().toDateString(), runsToday: 0, decisions: 0, seen: new Set<string>() };
  let after = "", lastDoc = "", lastPut = 0, pending: Timer | null = null, lastSentLine = "";

  function doc() {
    const r = d.current();
    if (stats.day !== new Date().toDateString()) Object.assign(stats, { day: new Date().toDateString(), runsToday: 0, decisions: 0 });
    if (r && !stats.seen.has(r.id)) { stats.seen.add(r.id); stats.runsToday++; }
    const waiting = r?.status === "awaiting approval" && r.final;
    const running = r?.status === "running" || r?.status === "sending";
    const state = waiting ? "waiting-on-george" : running ? "running" : r ? (r.status === "shipped" || r.status === "declined" ? "done" : "failed") : "done";
    const live = running ? d.helpers() : waiting ? `Chief passed the follow-up to ${r!.who ?? r!.company}. Waiting for George.` : lastSentLine || "Ready for the next conversation.";
    const card = {
      id: "deal", title: "Deal Synth",
      purpose: clean(`Runs the Deal Room: Crusoe, Band, Vultr, Neo4j, Plaud, OpenRouter, Brave, Similarweb. ${live}`),
      state, lastRun: r ? { at: iso(r.ended ?? r.started), status: waiting ? "waiting" : running ? "running" : r.status === "shipped" ? "sent" : r.status } : undefined,
      runsToday: stats.runsToday, drafts: waiting ? 1 : 0, decisions: stats.decisions,
    };
    const approvals = waiting ? [approval(r!)] : [];
    const notes = clean(d.notes?.() ?? live).slice(0, 3900);
    const team = d.team?.() ?? [];
    return { card, notes, ...(team.length ? { team } : {}), running: running ? [{ synth: "deal", status: clean(live), since: iso(r!.started), at: iso() }] : [], approvals };
  }

  function approval(r: RunLike) {
    const f = r.final, ref = `synths/deal/outbox/${r.id}.md`;
    const body: string = f.draft.body;   // exactly what Resend will send; never edited after this
    const sites = [...new Set((f.sources ?? []).map((s: any) => hostOf(s.url)).filter(Boolean))].slice(0, 3).join(", ");
    const name = r.who ?? r.company;
    return {
      type: "draft", synth: "deal", key: ref, file: ref, ref, title: clean(`Follow-up to ${r.company}`), status: "draft", channel: "email", kind: "email", at: iso(),
      ask: clean(`Chief and ${f.checker ?? "a checker"} passed v${f.version}; every claim traces to the conversation or a source.`),
      view: {
        who: "Deal Synth", rec: "yes",
        why: clean(`${name} is expecting this follow-up, and ${f.change ? "their agent already agreed the time" : "every claim checks out"}.`),
        question: clean(`Send this follow-up to ${name} at ${r.company}?`),
        context: clean(`Written from your conversation and fresh research. ${f.checker ?? "A checker"} verified every claim.${f.invite ? ` Includes a calendar invite for ${f.invite.label}${f.invite.cto ? ", asking them to bring their CTO" : ""}.${f.invite.conflict ? ` ${f.invite.conflict}` : ""}` : ""}${sites ? ` Sources: ${sites}.` : ""}`),
        yes: "Deal Synth is sending it now.", no: "Deal Synth drops this draft.",
      },
      body,
      preview: { kind: "email", to: r.to ? `${name} <${r.to}>` : name, from: "George at TRU Synth", subject: clean(f.draft.subject), body, signature: "George" },
      content_sha: createHash("sha256").update(body).digest("hex"),
    };
  }

  async function push() {
    pending = null;
    const body = JSON.stringify(doc());
    // the change test ignores the per-push timestamps; every PUT is a live event on George's phone
    const key = body.replace(/"at":"[^"]*"/g, "");
    if (key === lastDoc) return;
    const wait = 5000 - (Date.now() - lastPut);
    if (wait > 0) { pending = setTimeout(push, wait); return; }
    lastPut = Date.now();
    const t0 = Date.now();
    const r = await fetch(`${BASE}/deal/v1/doc`, { method: "PUT", headers: H, body, signal: AbortSignal.timeout(25000) }).catch(e => ({ ok: false, status: String(e) }) as any);
    if (r.ok) lastDoc = key; else { d.log(`app doc push failed after ${Date.now() - t0} ms (${Math.round(body.length / 1024)} KB): ${r.status} ${await r.text?.().catch(() => "") ?? ""}`.slice(0, 300)); lastPut = 0; pending ??= setTimeout(push, 10_000); }
  }
  // b28 shows replies verbatim: plain sentences only, no Markdown, no URLs (links live in proof rows)
  const flat = (t: string) => t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[*_`#>]+/g, "").replace(/[ \t]{2,}/g, " ").trim();
  const reply = (id: string, x: Record<string, unknown>) =>
    fetch(`${BASE}/deal/v1/reply`, { method: "POST", headers: H, body: JSON.stringify({ id, ...x, ...(typeof x.text === "string" ? { text: flat(x.text) } : {}), ...(typeof x.error === "string" ? { error: flat(x.error) } : {}) }), signal: AbortSignal.timeout(8000) }).catch(() => {});

  async function handle(row: any) {
    if (row.synth && row.synth !== "deal" && d.teamInbox) { await reply(row.id, await d.teamInbox(row)); push(); return; }
    const runId = String(row.ref ?? "").match(/outbox\/([^.]+)\.md/)?.[1];
    if (row.kind === "start") { if (row.real) await reply(row.id, { status: "sent", text: clean(d.current()?.status === "running" ? "Already on it: the Deal Room is working." : "Ready. Text Chief who you met and I'll open the Deal Room.") }); return; }
    if (row.kind === "chat" || row.kind === "message" || row.kind === "ask") {
      // "ask" must be answered within 25 s to stream live into his chat
      const text = await Promise.race([d.chat(String(row.text ?? "")), Bun.sleep(20_000).then(() => d.notes?.() ?? "The Deal Room is working; I'll have more in a moment.")]);
      await reply(row.id, { status: "sent", text: clean(text).slice(0, 3900) }); return;
    }
    const r = runId ? d.run(runId) : undefined;
    if (!r) { await reply(row.id, { status: "failed", error: "That draft is no longer open." }); return; }
    if (row.kind === "approve" && !row.real) { await reply(row.id, { status: "failed", text: "Test approval received. Nothing was sent." }); return; }
    if (r.final && row.content_sha && row.content_sha !== createHash("sha256").update(r.final.draft.body).digest("hex")) {
      await reply(row.id, { status: "failed", error: "The draft changed since you looked." }); return;
    }
    if (row.kind === "approve" || row.kind === "reject") {
      await d.decide(r, row.kind === "approve");   // idempotent: iMessage or the web may have decided first
      stats.decisions++;
      const name = r.who ?? r.company;
      if (row.kind === "reject") { lastSentLine = `Dropped the follow-up to ${name}.`; await reply(row.id, { status: "sent", text: "Dropped." }); }
      else if (r.sent?.ok) {
        lastSentLine = r.sent.dry ? `Dry run for ${name} at ${pt()} PT: nothing was sent.` : `Sent the follow-up to ${name} at ${pt()} PT.`;
        await reply(row.id, { status: "sent", text: r.sent.dry ? `Dry run: nothing was sent to ${name}.` : `Sent to ${name}. It went to ${r.to}.` });
      } else if (r.decision === "declined") await reply(row.id, { status: "failed", error: "This draft was already declined." });
      else await reply(row.id, { status: "failed", error: clean(`The email did not go out: ${r.sent?.error ?? "unknown error"}.`) });
      push();
    }
  }

  async function poll() {
    try {
      const r = await fetch(`${BASE}/deal/v1/inbox${after ? `?after=${encodeURIComponent(after)}` : ""}`, { headers: H, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j: any = await r.json();
        for (const row of j.rows ?? j.items ?? (Array.isArray(j) ? j : [])) {
          after = String(row.id);
          if (row.at && Date.now() - Date.parse(row.at) > 300_000) continue;   // backlog from before this server started
          await handle(row).catch(e => d.log(`inbox row failed: ${String(e).slice(0, 120)}`));
        }
      }
    } catch {}
    setTimeout(poll, 2000);
  }
  poll();
  push();
  return { changed() { if (!pending) pending = setTimeout(push, 400); } };
}
