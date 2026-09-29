// The room is the ONLY channel between workers. Two implementations behind one interface:
//   MockRoom: a local hub (the server's /hub WebSocket) that routes by @mention, like Band does.
//   BandRoom: the real Band room via @band-ai/sdk. Each worker is its own Band agent (own id + key = own identity).
export type Incoming = { id: string; roomId: string; from: string; text: string; payload?: any };
export type RoomCtx = {
  roomId: string;
  send(text: string, mentions: string[], payload?: unknown): Promise<void>;
  event(kind: "thought" | "tool_call" | "tool_result" | "error" | "task", text: string): Promise<void>;
  lookupPeers(): Promise<string[]>;
  addParticipant(name: string): Promise<void>;
  removeParticipant(name: string): Promise<void>;
};
export type Handler = (msg: Incoming, ctx: RoomCtx) => Promise<void>;

// Machine-readable handoff data rides at the end of the message, so a worker on another VM needs nothing but the room.
const TAG = "\n\n```synth\n";
export function encode(text: string, payload?: unknown) { return payload === undefined ? text : `${text}${TAG}${JSON.stringify(payload)}\n\`\`\``; }
export function decode(content: string): { text: string; payload?: any } {
  const i = content.indexOf("```synth");
  if (i < 0) return { text: content.trim() };
  const body = content.slice(i + 8).replace(/```\s*$/, "").trim();
  try { return { text: content.slice(0, i).trim(), payload: JSON.parse(body) }; } catch { return { text: content.slice(0, i).trim() }; }
}

export interface Room { join(name: string, onMessage: Handler): Promise<void> }

export class MockRoom implements Room {
  constructor(private hubUrl: string) {}
  async join(name: string, onMessage: Handler) {
    const connect = () => new Promise<void>((resolve) => {
      const ws = new WebSocket(`${this.hubUrl}?name=${encodeURIComponent(name)}`);
      const pending = new Map<string, (v: any) => void>();
      let seq = 0;
      const rpc = (op: string, args: any) => new Promise<any>((res) => { const rid = `${name}-${++seq}`; pending.set(rid, res); ws.send(JSON.stringify({ op, rid, ...args })); });
      ws.onopen = () => resolve();
      ws.onclose = () => setTimeout(() => connect(), 1000);
      ws.onmessage = async (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.rid && pending.has(m.rid)) { pending.get(m.rid)!(m.result); pending.delete(m.rid); return; }
        if (m.op !== "deliver") return;
        const { text, payload } = decode(m.content);
        const ctx: RoomCtx = {
          roomId: m.roomId,
          send: (t, mentions, p) => rpc("send", { roomId: m.roomId, content: encode(t, p), mentions }),
          event: (kind, t) => rpc("event", { roomId: m.roomId, kind, content: t }),
          lookupPeers: () => rpc("lookupPeers", { roomId: m.roomId }),
          addParticipant: (n) => rpc("addParticipant", { roomId: m.roomId, name: n }),
          removeParticipant: (n) => rpc("removeParticipant", { roomId: m.roomId, name: n }),
        };
        try { await onMessage({ id: m.id, roomId: m.roomId, from: m.from, text, payload }, ctx); }
        catch (e) { await ctx.event("error", `${name} failed: ${String(e).slice(0, 200)}`); }
      };
    });
    await connect();
  }
}

import { AGENTS, mentionRefs, nameOf } from "./agents";

export class BandRoom implements Room {
  async join(name: string, onMessage: Handler) {
    const { Agent, loadAgentConfigFromEnv, GenericAdapter } = await import("@band-ai/sdk") as any;
    const adapter = new GenericAdapter(async ({ message, tools }: any) => {
      if (process.env.DEBUG_BAND) console.log(`[${name}] got from ${message.senderName}: ${String(message.content).slice(0, 80)}`);
      const { text, payload } = decode(String(message.content ?? ""));
      const ctx: RoomCtx = {
        roomId: message.roomId,
        send: async (t, mentions, p) => { await tools.sendMessage(encode(t, p), mentionRefs(mentions)); },
        event: async (kind, t) => { await tools.sendEvent(t, kind); },
        lookupPeers: async () => {
          const r = await tools.lookupPeers(1, 50);
          const list = r?.data ?? r?.items ?? r?.results ?? (Array.isArray(r) ? r : []);
          return list.map((p: any) => nameOf(p.id ?? p.handle ?? p.name)).filter(Boolean);
        },
        removeParticipant: async (n) => {
          const { BandClient } = await import("@band-ai/rest-client");
          const rest = new BandClient({ apiKey: process.env.BAND_API_KEY! } as any);
          await rest.agentApiParticipants.removeAgentChatParticipant(message.roomId, AGENTS[n]?.id ?? n).catch(async () => { await tools.removeParticipant(n); });
        },
        addParticipant: async (n) => {
          // the SDK resolves by name; fall back to the handle if the name is ambiguous
          try { await tools.addParticipant(n, "member"); }
          catch {
            // the SDK's name lookup can miss; the same call over Band's agent REST API, as this worker, by peer id
            const { BandClient } = await import("@band-ai/rest-client");
            const rest = new BandClient({ apiKey: process.env.BAND_API_KEY! } as any);
            await rest.agentApiParticipants.addAgentChatParticipant(message.roomId, { participant: { participant_id: AGENTS[n]?.id ?? n, role: "member" } } as any);
          }
          await Bun.sleep(1500);   // give the recruit's socket a moment to join the room topic before we @mention it
        },
      };
      try { await onMessage({ id: message.id, roomId: message.roomId, from: nameOf(message.senderId ?? message.senderName), text, payload }, ctx); }
      catch (e) { await ctx.event("error", `${name} failed: ${String(e).slice(0, 200)}`); }
    });
    const { ConsoleLogger } = await import("@band-ai/sdk/core") as any;
    const agent = Agent.create({ adapter, config: loadAgentConfigFromEnv(), ...(process.env.DEBUG_BAND ? { logger: new ConsoleLogger() } : {}) } as any);
    // keep the one live connection up: on a drop or a slow handshake, wait (Band 429s fast reconnects) and retry
    const loop = async (): Promise<void> => {
      try { await agent.run(); }
      catch (e) { console.error(`[band] ${String(e).slice(0, 120)}; retrying in 15 s`); await Bun.sleep(15_000); return loop(); }
    };
    loop();   // holds the WebSocket open for the life of the process
  }
}
