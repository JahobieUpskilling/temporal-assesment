import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import type { OpeningInput, OpeningStatus, ReplyResult } from "./types";
import { SERVICES, STYLISTS, WAITLIST } from "./waitlist";
import {
  cancelOpening,
  clientReply,
  getOpeningStatus,
  lateReplyMessage,
  openingWorkflow,
  skipCurrent,
} from "./workflows";

export const TASK_QUEUE = "juniper-waitlist";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

// The simulated spreadsheet, so the page can show who is on the waitlist and
// let the demo "be" each client when replying.
app.get("/api/waitlist", (_request, response) => {
  response.json({ stylists: STYLISTS, services: SERVICES, clients: WAITLIST });
});

// Staff: a cancellation came in, start offering the opening.
app.post("/api/openings", async (request, response) => {
  const body = request.body ?? {};
  const startsAt = new Date(String(body.startsAt));
  if (Number.isNaN(startsAt.getTime())) {
    response.status(400).json({ error: "startsAt must be a valid date-time" });
    return;
  }
  const num = (value: unknown, fallback: number, min: number): number | undefined => {
    const n = value === undefined || value === "" ? fallback : Number(value);
    return Number.isFinite(n) && n >= min ? n : undefined;
  };
  const lengthMinutes = num(body.lengthMinutes, 45, 5);
  const replyWindowSeconds = num(body.replyWindowSeconds, 15 * 60, 1);
  const stopOfferingMinutesBefore = num(body.stopOfferingMinutesBefore, 30, 0);
  if (lengthMinutes === undefined || replyWindowSeconds === undefined || stopOfferingMinutesBefore === undefined) {
    response.status(400).json({ error: "lengthMinutes, replyWindowSeconds and stopOfferingMinutesBefore must be non-negative numbers" });
    return;
  }
  const opening: OpeningInput = {
    stylist: String(body.stylist ?? STYLISTS[0]),
    service: body.service ? String(body.service) : null,
    startsAt: startsAt.toISOString(),
    startsAtLabel: startsAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    lengthMinutes,
    replyWindowSeconds,
    stopOfferingMinutesBefore,
    simulateTextFailure: Boolean(body.simulateTextFailure),
  };
  const openingId = `opening-${randomUUID().slice(0, 8)}`;
  const client = await getClient();
  await client.workflow.start(openingWorkflow, {
    workflowId: openingId,
    taskQueue: TASK_QUEUE,
    args: [opening],
  });
  response.status(201).json({ openingId });
});

// Staff dashboard: every opening, newest first.
app.get("/api/openings", async (_request, response) => {
  const client = await getClient();
  const statuses: (OpeningStatus & { startedAt: string })[] = [];
  for await (const run of client.workflow.list({
    query: `WorkflowType = "openingWorkflow"`,
  })) {
    if (statuses.length >= 20) break;
    try {
      const status = await client.workflow.getHandle(run.workflowId).query(getOpeningStatus);
      statuses.push({ ...status, startedAt: run.startTime.toISOString() });
    } catch {
      // A Workflow with no Worker yet can't answer a Query; skip it for now.
    }
  }
  statuses.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  response.json(statuses);
});

app.get("/api/openings/:openingId", async (request, response) => {
  const client = await getClient();
  const status = await client.workflow
    .getHandle(request.params.openingId)
    .query(getOpeningStatus);
  response.json(status);
});

// Client: simulated inbound text ("YES" / "NO"). In production an SMS webhook
// would map the sender's phone number to the client and call this.
app.post("/api/openings/:openingId/reply", async (request, response) => {
  const { clientId, accepted } = request.body ?? {};
  if (typeof clientId !== "string" || typeof accepted !== "boolean") {
    response.status(400).json({ error: "clientId (string) and accepted (boolean) are required" });
    return;
  }
  const client = await getClient();
  const handle = client.workflow.getHandle(request.params.openingId);
  let result: ReplyResult;
  try {
    result = await handle.executeUpdate(clientReply, { args: [{ clientId, accepted }] });
  } catch (error) {
    // The Workflow already finished (filled, unfilled or cancelled): Updates
    // can't be delivered any more, but the final state still answers Queries.
    const status = await handle.query(getOpeningStatus).catch(() => undefined);
    if (!status || status.phase === "offering" || status.phase === "matching") throw error;
    result = { ok: false, message: lateReplyMessage(status, { clientId, accepted }) };
  }
  response.status(result.ok ? 200 : 409).json(result);
});

// Staff: move on from the current person without waiting for the timer.
app.post("/api/openings/:openingId/skip", async (request, response) => {
  const client = await getClient();
  await client.workflow.getHandle(request.params.openingId).signal(skipCurrent);
  response.status(202).json({ accepted: true });
});

// Staff: stop offering this opening entirely.
app.post("/api/openings/:openingId/cancel", async (request, response) => {
  const reason = String(request.body?.reason ?? "Cancelled by staff.");
  const client = await getClient();
  await client.workflow.getHandle(request.params.openingId).signal(cancelOpening, reason);
  response.status(202).json({ accepted: true });
});

app.use(
  (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "";
    // Routine client/staff mistakes get a 4xx, not a stack trace.
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: "Request body must be valid JSON" });
      return;
    }
    if (error instanceof WorkflowNotFoundError || /not found/i.test(message)) {
      response.status(404).json({ error: "No such opening" });
      return;
    }
    if (/already completed/i.test(message)) {
      response.status(409).json({ error: "This opening has already finished" });
      return;
    }
    console.error(error);
    response.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  },
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Juniper Salon waitlist is available at http://localhost:${port}`));
