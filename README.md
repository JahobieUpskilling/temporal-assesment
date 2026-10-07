# Juniper Salon — last-minute opening filler (Temporal prototype)

When an appointment cancels, Lena and Carla currently scan a Google Sheet
waitlist and text several people from the salon phone, then try to keep track
of who answered. This prototype turns each opening into a **Temporal Workflow**
that offers the slot to eligible waitlist clients **one at a time**, in the
order they joined, waits durably for each reply, and guarantees **exactly one
person** can take it.

## Run it

Requirements: Node.js 20+ and Docker.

```bash
npm install && npm run dev
```

- App (staff dashboard + simulated client phone): <http://localhost:3000>
- Temporal Web UI: <http://localhost:8233>

`npm run dev` starts the Temporal dev server in Docker, the Worker and the API.
`npm run stop` stops Temporal.

## Try the demo (2 minutes)

1. Click **Demo: 20-second window**, then **Start offering**. The default opening
   is tomorrow 10:00 with Lena, 45 minutes. Eligible clients appear in the
   order they joined the waitlist; the first one is texted and a countdown starts.
2. On the right, the **Client phone** shows the text the current holder received.
   Reply **NO** → the offer moves to the next person. Let a countdown run out →
   "no reply (timed out)" and it moves on again.
3. Pick someone who is *not* the current holder and reply **YES** → refused
   ("we haven't offered you this yet" / "your window ended").
4. As the current holder, reply **YES** → `filled`. Everyone contacted earlier
   is texted that it's taken, staff see who won and the reminder to book it in
   Square by hand.
5. Start another opening and use **Skip current** or **Cancel opening** to see
   the staff controls.
6. Tick **Simulate SMS outage** before starting: the first text fails and
   Temporal retries it; you can see the retry in the Web UI.

## What Lena asked for → how it's handled

| Lena's need | Prototype behaviour |
| --- | --- |
| Match by service, length, availability, requested stylist | `findEligibleClients` Activity filters the waitlist (service if staff pick one, service length fits the gap, client available at the start time, stylist preference), ordered by join date |
| Stop texting several people at once; one winner | One offer at a time; replies are a Temporal **Update** so only the current holder's YES can win |
| 15-minute reply window, then move on | `condition(..., replyWindow)` timer per client; configurable per opening |
| Late replies shouldn't take the slot | Refused with a clear message; logged under *Late / invalid replies* |
| Staff can cancel or skip | `cancelOpening` / `skipCurrent` Signals |
| See who has the offer, time left, outcome, who's contacted, who's waiting | `getOpeningStatus` Query drives the dashboard; survives reloads and restarts |
| Stop when too close to the appointment | `stopOfferingMinutesBefore` (default 30; Lena hasn't set a cutoff) |
| Tell staff if unfilled; tell others when filled | `notifyStaff` and "it's filled" texts |
| Don't touch Square | Nothing writes to Square; the winner's original booking is moved by staff |
| Several openings at once | A client holds at most one offer at a time (`claimClient`/`releaseClient` Activities); once they accept an opening they are no longer eligible for others (shown as "holding another offer / already booked") |

## Simulated or excluded

- **SMS** is simulated (`sendText` logs and records the message). A real
  provider (Twilio / Square Messages) plus an inbound webhook that maps a phone
  number to `POST /api/openings/:id/reply` is the next step.
- **Waitlist** is a hard-coded copy of the spreadsheet (`src/waitlist.ts`).
- **Square** integration is out of scope at Lena's request.
- **Open question for Lena:** whether a client who accepts should be removed
  from the broader waitlist (the prototype only removes them from the offer).
- No authentication; this is a local prototype.

## Tests

```bash
npm test          # Workflow tests with Temporal's time-skipping test server (no Docker)
npm run test:e2e  # Playwright end-to-end against the running app (needs `npm run dev`)
npm run typecheck
```

The Workflow tests cover one-winner acceptance with a late YES, timeouts
rolling through the queue, and staff cancellation. The Playwright suite drives
the real browser through acceptance, expiry → next offer, stale and duplicate
replies, queue-jumping, skip/cancel, reload during an active offer, and checks
the Workflow appears in the Temporal Web UI; any console or API error fails
the test.

### Worker recovery

Start an opening, kill the Worker (`Ctrl+C` or `pkill -f worker.ts`) while an
offer is live, then `npm run dev:worker` again. The countdown keeps running,
replies still arrive, and the Workflow picks up where it left off — the state
lives in Temporal, not in the process.

## Repository map

- `src/workflows.ts` — `openingWorkflow`: offers, timers, Update/Signal/Query handlers
- `src/activities.ts` — eligibility matching, simulated SMS, staff notification
- `src/waitlist.ts` — simulated spreadsheet data
- `src/api.ts` — Express API + Temporal Client
- `src/worker.ts` — Worker on the `juniper-waitlist` task queue
- `public/` — staff dashboard and simulated client phone
- `tests/` — Workflow tests, `e2e/` — Playwright
- `evidence/` — Temporal Web UI screenshot (taken during the worker-recovery check)
- `slides/juniper-salon-prototype.pdf` — 4-slide presentation for Lena
- `CUSTOMER_NOTES.md` — the conversation with Lena
