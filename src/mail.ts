// The ship action: send the approved email. Only Desk calls this, and only after George taps Approve.
// Resend over HTTPS; the key is read at runtime and never logged. Failures are returned, never faked.
export const FROM = process.env.MAIL_FROM ?? "George Trushevskiy · TRU Synth <george@synths.trusynth.com>";
export const REPLY_TO = process.env.MAIL_REPLY_TO ?? "george@trusynth.com";
const sentAt: number[] = [];

export const validEmail = (e: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(e) && e.length <= 120;

export async function sendEmail(key: string | undefined, to: string, subject: string, text: string, attachments?: { filename: string; content: string; content_type?: string }[]): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!key) return { ok: false, error: "no email sender configured (hackday-resend-api missing)" };
  if (!validEmail(to)) return { ok: false, error: "not a valid email address" };
  const hour = Date.now() - 3600_000;
  while (sentAt.length && sentAt[0]! < hour) sentAt.shift();
  if (sentAt.length >= 10) return { ok: false, error: "rate limit: 10 emails per hour" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, text, ...(attachments?.length ? { attachments } : {}) }), signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `sender said ${r.status}: ${String(j.message ?? j.name ?? "").slice(0, 120)}` };
    sentAt.push(Date.now());
    return { ok: true, id: j.id };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}
