# Evidence

`temporal-web-ui.png` (timeline) and `temporal-event-history.png` (event
list) show the Temporal Web UI for one representative opening,
`opening-81bfd667`, captured during the worker-recovery check
(`node scripts/capture-evidence.mjs <workflowId>` regenerates them):

1. The opening was started with "simulate SMS outage" on, so the first
   `sendText` Activity failed once and Temporal retried it.
2. Priya N. received the offer; the Worker process was then killed while her
   reply window was running.
3. With no Worker alive, staff pressed **Skip current** — the `skipCurrent`
   Signal was accepted by the Temporal server and queued.
4. The Worker was restarted. The Workflow resumed, applied the Signal, marked
   Priya as skipped and offered the slot to Sam K.
5. Sam replied YES via the `clientReply` Update; the Workflow sent the
   "it's filled" texts, notified staff, and completed as `filled`.

All names and phone numbers are fictional (see `src/waitlist.ts`).
