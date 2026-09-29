// Scheduler Synth: holds the agreed slot and sends George the invite. Reads George's calendar as free/busy only
// (times, never titles: the wall is public), picks the slot the other side agreed (or the next free one), makes an
// .ics and sends it to george@ only, through Resend. The Resend id is the proof.
import { sendEmail } from "../mail";
import { views } from "../browser";
import type { Executor } from "./types";

const FEED = process.env.CAL_FEED ?? `${process.env.HOME}/Genie/scratch/overnight/always-on/cal-feed/events.json`;
const TO = "george@trusynth.com";
const TZ = "America/Los_Angeles";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// minutes east of UTC for PT on a given day (PDT -420, PST -480)
const ptOffset = (d: Date) => { const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(d).find(p => p.type === "timeZoneName")!.value; return Number(s.replace("GMT", "") || 0) * 60; };
const ptParts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
// the UTC instant of a PT wall time
const ptToUtc = (y: number, m: number, d: number, h: number, min: number) => { const guess = new Date(Date.UTC(y, m - 1, d, h, min)); return new Date(guess.getTime() - ptOffset(guess) * 60_000); };

// the latest Deal Room run that agreed a time (the other side's answer), else Wednesday 2:30 PM PT
async function agreed(): Promise<{ day: number; h: number; m: number; who: string; company: string; extra: string; from: string }> {
  try {
    const runs = JSON.parse(await Bun.file("runs/state.json").text()) as any[];
    for (const r of runs.slice().reverse()) {
      const c: string = r.final?.change ?? "";
      const x = /(mon|tue|wed|thu|fri)[a-z]*\s+(?:at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)/i.exec(c);
      if (x) return { day: DAYS.findIndex(d => d.toLowerCase() === x[1]!.slice(0, 3).toLowerCase()), h: (Number(x[2]) % 12) + (/pm/i.test(x[4]!) ? 12 : 0), m: Number(x[3] ?? 0), who: r.who ?? r.company, company: r.company, extra: /cto/i.test(c) ? " + their CTO" : "", from: `run ${r.id}${r.kind === "real" ? "" : " (rehearsal)"}` };
    }
  } catch {}
  return { day: 2, h: 14, m: 30, who: "Alex Rivera", company: "Northwind Labs", extra: " + their CTO", from: "the default (no agreed time on file)" };
}

// "Wednesday at 2:30 PM PT" → the next such weekday's instant (PT), for the Deal email's invite too
export function slotFrom(text: string): { start: Date; label: string } | null {
  const x = /(mon|tue|wed|thu|fri)[a-z]*\s+(?:at\s+)?(\d{1,2})(?::(\d\d))?\s*(am|pm)/i.exec(text);
  if (!x) return null;
  const day = DAYS.findIndex(d => d.toLowerCase() === x[1]!.slice(0, 3).toLowerCase()), h = (Number(x[2]) % 12) + (/pm/i.test(x[4]!) ? 12 : 0), m = Number(x[3] ?? 0);
  const p = ptParts(new Date()), todayIdx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday!);
  const ahead = (day - todayIdx + 7) % 7 || 7;
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + ahead));
  return { start: ptToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m), label: `${DAYS[day]} ${d.toISOString().slice(0, 10)} at ${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"} PT` };
}
// is George busy at this instant (free/busy only)? if so, the next free half hour on a weekday, 9 AM to 5 PM PT
export async function calendarCheck(start: Date): Promise<{ busy: boolean; next?: string } | null> {
  let events: { start: string; end: string; allday?: boolean }[];
  try { events = JSON.parse(await Bun.file(FEED).text()); } catch { return null; }
  const spans = events.filter(e => !e.allday).map(e => [Date.parse(e.start), Date.parse(e.end)] as const);
  const busyAt = (t: number) => spans.some(([s, e]) => s < t + 30 * 60_000 && e > t);
  if (!busyAt(start.getTime())) return { busy: false };
  for (let t = start.getTime() + 30 * 60_000; t < start.getTime() + 14 * 86_400_000; t += 30 * 60_000) {
    const p = ptParts(new Date(t)), h = Number(p.hour) % 24 + Number(p.minute) / 60;
    if (["Sat", "Sun"].includes(p.weekday!) || h < 9 || h > 16.5 || busyAt(t)) continue;
    return { busy: true, next: `${p.weekday} ${Number(p.hour) % 12 || 12}:${p.minute} ${Number(p.hour) >= 12 ? "PM" : "AM"} PT` };
  }
  return { busy: true };
}

// a real invite: METHOD:REQUEST with the attendees, so calendar apps offer Accept
export function inviteIcs(start: Date, mins: number, summary: string, desc: string, attendees: string[]) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TRU Synth//Deal Synth//EN", "METHOD:REQUEST", "BEGIN:VEVENT",
    `UID:${f(start)}-${Math.random().toString(36).slice(2, 8)}@synths.trusynth.com`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(start)}`, `DTEND:${f(new Date(start.getTime() + mins * 60_000))}`,
    `SUMMARY:${summary}`, `DESCRIPTION:${desc.replace(/\n/g, "\\n")}`, `ORGANIZER;CN=George Trushevskiy:mailto:${TO}`,
    ...attendees.map(a => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`), "STATUS:CONFIRMED", "SEQUENCE:0", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

const ics = (start: Date, mins: number, summary: string, desc: string) => {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TRU Synth//Scheduler Synth//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${f(start)}-scheduler@synths.trusynth.com`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(start)}`, `DTEND:${f(new Date(start.getTime() + mins * 60_000))}`,
    `SUMMARY:${summary}`, `DESCRIPTION:${desc.replace(/\n/g, "\\n")}`, `ORGANIZER;CN=George Trushevskiy:mailto:${TO}`, "STATUS:TENTATIVE", "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
};

const scheduler: Executor = {
  synth: "scheduler", name: "Scheduler Synth", title: "Chief of staff for time", kind: "invite", sponsors: ["Crusoe", "Resend", "Vultr"],
  async propose() {
    const a = await agreed();
    const when = `${DAYS[a.day]} ${a.h % 12 || 12}:${String(a.m).padStart(2, "0")} ${a.h >= 12 ? "PM" : "AM"} PT`;
    return { task: `Hold ${when} for the ${a.company} call and send you the invite`, why: `${a.company}'s agent agreed ${when}${a.extra}; a hold stops anything else landing there.`, input: {} };
  },
  async run(ctx) {
    const a = await agreed();
    ctx.log(`Agreed time from ${a.from}: ${DAYS[a.day]} ${a.h}:${String(a.m).padStart(2, "0")} PT`);
    // the target week: the next such weekday after today (PT)
    const now = new Date(), p = ptParts(now);
    const todayIdx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday!);
    let ahead = (a.day - todayIdx + 7) % 7 || 7;
    const base = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + ahead));
    const monday = new Date(base.getTime() - a.day * 86_400_000);
    ctx.log("Reading your calendar: free/busy only, no titles");
    let events: { start: string; end: string; allday?: boolean }[] = [];
    try { events = JSON.parse(await Bun.file(FEED).text()); } catch { throw new Error("the calendar feed could not be read"); }
    const off = (d: number) => d + (d >= 5 ? 2 : 0);
    const busy: { day: number; from: number; to: number }[] = [];
    const busyAt = (d: number, h: number) => busy.some(b => b.day === d && h >= b.from && h < b.to);
    for (const e of events) {
      if (e.allday) continue;
      const s = new Date(e.start), en = new Date(e.end);
      for (let d = 0; d < 10; d++) {   // this week and next: weekday index d → calendar offset (skip the weekend)
        const dayStart = ptToUtc(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate() + off(d), 0, 0), dayEnd = new Date(dayStart.getTime() + 86_400_000);
        if (en <= dayStart || s >= dayEnd) continue;
        const from = Math.max(0, (s.getTime() - dayStart.getTime()) / 3.6e6), to = Math.min(24, (en.getTime() - dayStart.getTime()) / 3.6e6);
        busy.push({ day: d, from, to });
      }
    }
    ctx.proof("number", { label: "Busy blocks in the next two weeks", value: busy.length, from: "George's calendar feed (times only)" });
    // the agreed slot if it's free; else the next free half hour (9 AM to 5 PM PT) that day or the days after, said plainly
    let day = a.day, h = a.h + a.m / 60, moved = "";
    while (busyAt(day, h) || busyAt(day, h + 0.49)) {
      h += 0.5; moved = ` (the agreed ${DAYS[a.day]} ${a.h % 12 || 12}:${String(a.m).padStart(2, "0")} was busy on your calendar, so the next free half hour)`;
      if (h > 16.5) { day++; h = 9; if (day > 9) throw new Error("no free half hour in the next two weeks; not holding anything"); }
    }
    const wk = Math.floor(day / 5), wd = day % 5;
    a.day = wd;
    const weekMon = new Date(monday.getTime() + wk * 7 * 86_400_000);
    const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    const label = `${hh % 12 || 12}:${String(mm).padStart(2, "0")} PT`;
    const dateStr = new Date(weekMon.getTime() + wd * 86_400_000).toISOString().slice(0, 10);
    await ctx.page.view("calendar", views.calendar(`George · week of ${weekMon.toISOString().slice(5, 10)}`, busy.filter(b => Math.floor(b.day / 5) === wk && b.to > 8 && b.from < 18).map(b => ({ ...b, day: b.day % 5 })), { day: a.day, at: h, label: `${label}${a.extra ? " + CTO" : ""}` },
      `Free/busy only. Holding ${DAYS[a.day]} ${dateStr} at ${label}${moved}.`), `Holding ${DAYS[a.day]} ${label}${moved}`.slice(0, 80));
    await ctx.shot(`Free/busy with the held slot (${DAYS[a.day]} ${label})`);
    const start = ptToUtc(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)), Number(dateStr.slice(8, 10)), hh, mm);
    const invite = ics(start, 30, `${a.company} x TRU Synth${a.extra ? " (with their CTO)" : ""}`, `Held by Scheduler Synth. Agreed by ${a.company}'s agent in the Deal Room (${a.from}).`);
    ctx.proof("id", { label: "Slot (UTC)", value: start.toISOString() });
    ctx.log(`Sending the invite to ${TO} through Resend`);
    const r = await sendEmail(ctx.keys.resend, TO, `Hold: ${a.company} call, ${DAYS[a.day]} ${dateStr} ${label}`,
      `Scheduler Synth held ${DAYS[a.day]} ${dateStr} at ${label} for the ${a.company} call${a.extra}.${moved}\n\nThe invite is attached. Only you received it.`, [{ filename: "invite.ics", content: Buffer.from(invite).toString("base64") }]);
    if (!r.ok) throw new Error(`the invite did not send: ${r.error}`);
    ctx.proof("id", { label: "Resend id", value: r.id });
    ctx.proof("result", { title: "Invite held", lines: [`${DAYS[a.day]} ${dateStr}, ${label}, 30 minutes`, `${a.company}${a.extra}`, `Sent to George only`, `Agreed in ${a.from}`] });
    return `Held ${DAYS[a.day]} ${label} and sent the invite to George (Resend ${r.id}).`;
  },
};
export default scheduler;
