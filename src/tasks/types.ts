// TEAM tasks: a Synth proposes a task, George approves it in the app, the Synth does it LIVE in its own
// streamed browser and leaves proof (runs/proof/<taskId>.json, rendered by /proof/<taskId>).
// To add a Synth: write an Executor in src/tasks/<synth>.ts and list it in src/tasks/index.ts.
import type { Eye } from "../browser";

export type ProofKind = "step" | "shot" | "source" | "id" | "number" | "result" | (string & {});
export type Proposal = {
  task: string;         // the Review card's one line, e.g. "Brief: 3 alternatives to Band for agent rooms, with sources"
  why: string;          // one plain sentence
  input?: Record<string, unknown>;   // handed to run() when George approves
  body?: string;        // the card's body when it IS the thing approved (e.g. the exact post text); content_sha covers it
};
export type TaskCtx = {
  taskId: string;
  synth: string;        // "research", "qa", ... (also the wall tile id: /wall?synth=<synth>)
  input: Record<string, unknown>;
  page: Eye;            // this Synth's own live browser (read-only: goto, highlight, scroll, read, shot, evaluate)
  log(line: string): void;                        // the running line on the card, and a "step" proof
  proof(kind: ProofKind, data: Record<string, unknown>): void;
  shot(caption: string): Promise<void>;           // screenshot the page into the proof timeline
  frame(jpegBase64: string, caption: string, url?: string): void;   // push a picture from elsewhere (e.g. another browser) to the wall + the app's Live view
  think(system: string, user: string, o?: { maxTokens?: number; model?: string }): Promise<string>;   // Crusoe, OpenRouter fallback
  keys: Record<string, string | undefined>;       // runtime keys (never log, write or put them in proof)
  signal: AbortSignal;  // 10 minute cap
};
export type Executor = {
  synth: string;        // id, lowercase
  name: string;         // "Research Synth"
  title: string;        // view.who, e.g. "Research lead"
  kind: string;         // the proof page's kind: brief | qa | growth | vm | burn | ...
  sponsors: string[];
  propose(): Proposal | Promise<Proposal>;
  run(ctx: TaskCtx): Promise<string>;   // resolves to a one-line summary; throw to fail honestly
};
