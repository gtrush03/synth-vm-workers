# Build log

SYNTH was built during The AI Conference Hack Day 2026 (Pier 48, San Francisco, 29 Sep 2026). This public repo is a snapshot of the working repo at `fbefb4c`. Its day-of commit history is listed below (UTC, oldest first).

```
2026-09-29 11:09  911bad8  SYNTH: VM Workers M1: worker processes coordinate only via room (mock hub + Band adapter), Crusoe per-worker models with failover, Scout web research, Chief veto + runtime F
2026-09-29 11:24  5d9a66d  M2: live Band room (5 agents, own ids), Desk over REST, mentions by id, REST fallback for runtime recruit, 5-participant cap
2026-09-29 11:58  1793723  WIP quality pass: sender profile + code signature, placeholder/filler/subject guards, veto hero banner, email fields + Resend send-on-approve (honest failure), one reused Ba
2026-09-29 11:59  f97ffda  graph: no-op stubs for the deal-graph interface (recordSource/recordClaim/recordDecision/pathFor)
2026-09-29 12:02  8a163d7  graph: Neo4j Aura deal graph (HTTPS Query API, db = instance id): sources/transcript lines, versioned claims, decisions, commitments; pathFor, runGraph, unsupportedClaims; l
2026-09-29 12:06  118e0b8  Deal Room API: bearer-auth POST /api/run, GET /api/run/:id, approve/reject (idempotent, dry mode); Desk reads Band over REST (processing→processed); strict run matching; gra
2026-09-29 12:07  46aa7a9  meter: fallbacks per call, at, runId, 60-call history for the Crusoe panel
2026-09-29 12:09  90fcf97  graph view + Crusoe panel: /graph force graph (tap a claim → every version back to the transcript second or source, BLOCKED in red), /panel per-call Crusoe table (model, ms,
2026-09-29 12:18  a8742de  Deal Room core: transcript trip-wire + Scribe at Desk, content-based runtime recruit (Scheduler/Pricing/Tech/Legal, PartnerCheck on a 2nd Band account), Chief BLOCKED langua
2026-09-29 12:19  ae5eac1  Deal Synth app bridge (PUT /deal/v1/doc, poll inbox, idempotent approve via decide, test approvals send nothing, chat) + POST /api/chat
2026-09-29 12:21  1b87d36  graph: read-time repair for real runs: versions paired by content (or a blocked same-id claim), decisions attached to the version their reason describes, VETOs without claim
2026-09-29 12:25  ff4f65f  Counterparty boundary step (dismiss checker, add other-company agent, commitments only), checker retry, safe sign-off strip, Deal token, worker-spec for VMs, subject overrid
2026-09-29 12:29  4d7ada4  Counterparty proposes the plan change (new time + CTO) and Echo updates to it; view who/rec/why for the app
2026-09-29 12:29  17257d3  graph: promisesToday() (today's commitments + George's grounded email promises, grouped by person; who/what/due/kept-or-open/follow-up sent/the source second; deduped across
2026-09-29 12:31  9346efe  persist runs across restarts (decision on disk before sending), real/rehearsal run kind, graph-backed promises chat, promised repo link, company-name autocorrect, app start/
2026-09-29 12:32  2e3d09b  VM_MODE=vultr: skip roles in runs/vms.json, show their VM on the tile
2026-09-29 12:33  8a4319d  graph: run kind real vs rehearsal (untagged = rehearsal). promisesToday() is real runs only unless includeRehearsals; recordRun({kind}), setRunKind, runKind; /api/graph + /a
2026-09-29 12:34  608e2ff  vms.json: read {vms:[...]}, only active workers
2026-09-29 12:36  69ee779  app bridge: notes for the Ask answer; PUT only on real change, at most every 5 s
2026-09-29 12:46  2677865  live browser wall: each worker's own headless browser (raw CDP), screencast to /frames; stable telemetry token; dry runs stay out of the app; app 'ask' kind
2026-09-29 12:46  d937f65  wall: every Synth's live browser on the big screen (/wall). Tiles fit 1920x1080 with name, where it runs (Vultr region + VM, else this Mac), model and action line; newest-fr
2026-09-29 12:48  9b2d4da  heartbeat revives an off tile
2026-09-29 12:50  785fbbc  wall views: readable at tile size
2026-09-29 12:51  fc3159d  TEAM: /proof/<taskId> result page (task, Synth, where it ran, model, approved by George at, start/end/took, result, numbers only with their source, key ids, steps with scree
2026-09-29 12:52  8da89cc  TEAM tasks: executor interface (src/tasks/types.ts), persisted runner, Research executor; public redaction under x-public (no addresses, no transcripts); email footer link t
2026-09-29 12:53  26fa347  TEAM: runner in the server, team-* cards + Review items + Watch live/Proof rows in the app doc, team inbox (approve/reject/chat/start), /api/tasks
2026-09-29 12:54  a89ce8f  public host (x-public: 1): no email addresses in /api/graph*, /api/proof; runs of kind real show no transcript text (lines + commitments become (private), quoted speech in c
2026-09-29 12:55  0514822  wall never blank: idle page per role + 1 fps stills when static
2026-09-29 12:57  f364e4a  dry runs say so at the gate
2026-09-29 12:58  1bf2627  wall: Bing fallback when Brave bot-checks a VM IP; real standby view for checkers
2026-09-29 12:58  935265e  Scout idle: HN front page
2026-09-29 13:02  da5176c  research: parse wrapped arrays, retry on a second Crusoe model
2026-09-29 13:03  d8426f6  TEAM: Ops Synth (one demo Vultr VM in sjc serving its own status page, opened in its browser; proof = id, region, IP, page, delete time; cap 1, reaped at 03:00Z) + Finance S
2026-09-29 13:04  afbbf1e  search: Brave then Bing (honest about bot checks); lenient load; pending tasks carry Watch live + Proof rows
2026-09-29 13:06  d090be2  wall: honest location (Vultr · <city> · <vm8> from identity, this Mac only when the tile reports a Mac host, nothing when unknown; never the IP); the grid fits any viewport 
2026-09-29 13:07  2a0d121  Finance: OpenRouter shows today's spend (from /key) and the $10 promo grant as a hand reading from the dashboard (the API doesn't expose grants); the key limit is labelled a
2026-09-29 13:07  1ebe661  vms.ts: retry Vultr 5xx on reads/deletes (never re-POST a create); the reaper keeps retrying for 2 h so an API outage at 03:00Z can't leave VMs running
2026-09-29 13:08  f4717a4  SSE through proxies: no-transform + 5 s keepalive; doc PUT 25 s timeout, retry, size in the log
2026-09-29 13:09  120f9da  /frames/poll for tunnels that drop SSE
2026-09-29 13:10  a1d6455  wall: frame polling fallback (/frames/poll?since, ~350 ms) when SSE is silent for 3 s, /state every 2 s without events; Memory Synth executor (promisesToday on REAL runs onl
2026-09-29 13:15  396f7cb  VM frames: idle still every 5 s, max ~3 fps, smaller JPEGs (tunnel + data saver)
2026-09-29 13:15  8142f4e  Eye.viewport for QA's phone size; x-public frames hide private own views (transcript, memory)
2026-09-29 13:17  5f99115  Scheduler Synth: free/busy from George's feed (times only), holds the agreed slot, .ics to george@ via Resend; mail attachments
2026-09-29 13:18  616c9a6  in-app Live view: the working Synth's browser to live.jpg (≤2/s, 409 backoff, no private views)
2026-09-29 13:19  c77bed9  Growth Synth: 5 fits from a public event page with sources, intro drafts as their own Review items (never sent); Similarweb honestly marked unavailable
2026-09-29 13:21  397989b  wall: private own views (jpeg "" on the public host) show a neutral placeholder, never a stale frame; only the recruited checker gets a tile (idle Standing by frames don't c
2026-09-29 13:21  ea98268  app replies: plain sentences, no Markdown or URLs
2026-09-29 13:22  e282061  team Synths get a /state tile while they work (where + model)
2026-09-29 13:23  a56c02c  README: problem, the run, the TEAM, stack and why each piece, honest limits (Band 5-seat cap), code map
2026-09-29 13:23  cf054ba  research: spread sources; proof approver label
2026-09-29 13:25  ef51a40  app Live view: step feed + address bar via /deal/v1/live; Pause/Resume from the Live view holds the Synth between browser steps
2026-09-29 13:26  550ea00  log live.jpg / live feed outcomes once per synth
2026-09-29 13:29  b930ce1  scripts/capture.ts: record the wall at 1920x1080 (tab in the shared Chrome), raw tile frames, beat timeline, mp4s
2026-09-29 13:30  08d53df  Deal email carries a real calendar invite (METHOD:REQUEST, recipient as attendee) for the time the other side's agent agreed; George's card says so
2026-09-29 13:31  bd43ca4  Social Synth: drafts one post from the team's real work + a redacted wall picture; George approves the exact text (content_sha); d2's hook posts it, its screen streams to th
2026-09-29 13:32  e46db5a  social: fix a broken line
2026-09-29 13:33  587d714  social: body = exact post (f0 rule), @trusynth, only a real tap posts (else dry), API approvals always dry
2026-09-29 13:34  7392c80  live.jpg: never for dry runs
2026-09-29 13:36  7aac4c4  TEAM: QA Synth checks trusynth.com at phone size (390x844 via Eye.viewport): same-host crawl (max 25 pages, ~1 req/s, robots.txt respected, never opens sign-in/download/API 
2026-09-29 13:36  4679cdf  social: rehearsals called rehearsals; no dangling link sentence
2026-09-29 13:40  3c1bea7  social: real post = --real true --content-sha <sha> --approval <ref>, only from George's real tap
2026-09-29 13:41  aaf861f  scheduler: when the agreed slot is busy, hold the next free half hour that week and say so
2026-09-29 13:50  875375a  record: one-tab presenter for the HackerSquad recording (/record, 6 scenes: problem, film, LIVE wall, results, stack, code)
2026-09-29 13:54  2501c8f  server: reap stale worker processes at startup (orphans piled up across restarts)
2026-09-29 13:54  c9d9709  capture: --build rebuilds mp4s + timeline from frames on disk
2026-09-29 13:54  b8a9042  pageshot: 1080p public-view stills from the shared Chrome
2026-09-29 14:00  730201e  scheduler: search this week and next for a free half hour
2026-09-29 14:00  e32a8dd  record: S4 shows George's approved result first, else tonight's real-world test tagged as what it was (Rehearsal / Test run / Dry run · time); a dry-run post reads 'Typed, n
2026-09-29 14:06  f27932f  Deal card: keep the agreed time on the invite, and say so when George's calendar is busy then (with Scheduler's next free slot)
2026-09-29 14:20  87bfb91  x-public: redact contact names as 'the contact'; rehearsals use the fictional Alex Rivera, Northwind Labs
2026-09-29 14:22  55d2b51  preview: sample Echo block mark uses the fictional rehearsal contact (Alex Rivera), not a real person's first name
2026-09-29 14:40  4c5c020  transcript-demo: fictional contact only (Alex Rivera, Northwind Labs)
2026-09-29 15:04  168914f  scripts/graphshot: 1080p populated /graph still + screencast for the film
2026-09-29 15:24  d650a2d  README: demo film at the top (poster links to live.trusynth.com/film.mp4)
2026-09-29 15:42  ac966e9  README: film is 2:31 (the Siren cut now at live.trusynth.com/film.mp4)
2026-09-29 16:02  fbefb4c  README: film poster and link open live.trusynth.com/record (streams from R2)
```
