// Desk on the real Band platform: George's side of the room. It opens the room over REST (as the Desk agent),
// adds the starting workers, posts the task, and listens on its own WebSocket for whatever @mentions Desk.
import { BandClient } from "@band-ai/rest-client";
import type { Keys } from "./keys";
import { AGENTS, mentionRefs, nameOf } from "./agents";

type Inbound = { id: string; roomId: string; from: string; content: string };

export class BandDesk {
  private rest: BandClient;
  constructor(private keys: Keys, private onMessage: (m: Inbound) => void) {
    this.rest = new BandClient({ apiKey: keys.band!.Desk!.key } as any);
  }

  // Desk reads the room over REST (next unprocessed message addressed to it). Its WebSocket would miss a reused
  // room it was not added to while online, and polling survives restarts.
  private seen = new Set<string>();
  async start() {
    const tick = async () => {
      if (this.room) {
        for (let i = 0; i < 10; i++) {
          const r: any = await this.rest.agentApiMessages.getAgentNextMessage(this.room).catch(() => null);
          const m = r?.data ?? r;
          if (!m?.id) break;
          // Band wants processing → processed, or the same message comes back as "next" forever
          await this.rest.agentApiMessages.markAgentMessageProcessing(this.room, m.id).catch(() => {});
          await this.rest.agentApiMessages.markAgentMessageProcessed(this.room, m.id).catch(() => {});
          if (this.seen.has(m.id)) continue;
          this.seen.add(m.id);
          this.onMessage({ id: m.id, roomId: this.room, from: nameOf(m.sender_id ?? m.sender_name), content: String(m.content ?? "") });
        }
      }
      setTimeout(tick, 700);
    };
    tick();
  }

  // Free tier: 10 rooms per account and no delete, so Desk keeps ONE live room and reuses it for every run.
  // FactCheck is taken out before each run, so Chief's recruit is real every time.
  private room?: string;
  async openRoom(members: string[], title: string): Promise<string> {
    if (!this.room) {
      const list: any = await this.rest.agentApiChats.listAgentChats({ page_size: 50 } as any);
      const chats = list?.data ?? [];
      const mine = chats.find((c: any) => /^SYNTH live/.test(c.title ?? "")) ?? chats.find((c: any) => /^SYNTH/.test(c.title ?? ""));
      if (mine) this.room = mine.id;
      else {
        const r: any = await this.rest.agentApiChats.createAgentChat({ chat: { title: "SYNTH live room" } } as any);
        this.room = r?.data?.id ?? r?.id;
      }
    }
    const roomId = this.room!;
    await this.rest.agentApiChats.renameAgentChat(roomId, { chat: { title: `SYNTH live · ${title}`.slice(0, 120) } } as any).catch(() => {});
    const parts: any = await this.rest.agentApiParticipants.listAgentChatParticipants(roomId);
    const inRoom = new Set((parts?.data ?? []).map((p: any) => p.id));
    // The SDK only subscribes to rooms an agent is added to while it is online, so every run re-adds the starting
    // workers (a remove + add), and takes FactCheck out so it can be recruited again.
    await Promise.all(Object.entries(AGENTS).filter(([n]) => n !== "Desk" && inRoom.has(AGENTS[n]!.id)).map(([, a]) =>
      this.rest.agentApiParticipants.removeAgentChatParticipant(roomId, a.id).catch(() => {})));
    for (const name of members)
      await this.rest.agentApiParticipants.addAgentChatParticipant(roomId, { participant: { participant_id: AGENTS[name]!.id, role: "member" } } as any);
    await Bun.sleep(1200);   // let their sockets join the room topic
    return roomId;
  }

  async post(roomId: string, content: string, mentions: string[]) {
    await this.rest.agentApiMessages.createAgentChatMessage(roomId, {
      message: { content, mentions: mentionRefs(mentions) },
    } as any);
  }
}
