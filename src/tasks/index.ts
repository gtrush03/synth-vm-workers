// The TEAM: every Synth that can take a task. Add yours here.
import type { Executor } from "./types";
import research from "./research";

const optional = async (p: string): Promise<Executor[]> => { try { return [(await import(p)).default].filter(Boolean); } catch { return []; } };
export async function loadExecutors(): Promise<Executor[]> {
  return [research, ...await optional("./qa"), ...await optional("./growth"), ...await optional("./ops"), ...await optional("./finance"), ...await optional("./scheduler"), ...await optional("./memory"), ...await optional("./social")];
}
