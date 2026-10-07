import assert from "node:assert/strict";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type * as activities from "../src/activities";
import type { OpeningInput, OpeningStatus, WaitlistClient } from "../src/types";
import { cancelOpening, clientReply, getOpeningStatus, openingWorkflow } from "../src/workflows";

const TASK_QUEUE = "opening-test";

const clients: WaitlistClient[] = ["c1", "c2", "c3"].map((id, i) => ({
  id,
  name: `Client ${i + 1}`,
  phone: `555-010${i + 1}`,
  service: "Cut",
  serviceMinutes: 45,
  preferredStylist: null,
  availableFrom: "09:00",
  availableTo: "18:00",
  joinedWaitlistAt: `2026-10-0${i + 1}T10:00:00Z`,
}));

const opening: OpeningInput = {
  stylist: "Lena",
  startsAt: "2030-01-01T14:00:00.000Z",
  lengthMinutes: 45,
  replyWindowSeconds: 15 * 60,
  stopOfferingMinutesBefore: 30,
  simulateTextFailure: false,
};

// Fake Activities so the test needs no spreadsheet or SMS provider.
function fakeActivities(sent: string[]): typeof activities {
  return {
    findEligibleClients: async () => clients,
    sendText: async (input) => {
      sent.push(`${input.kind}:${input.to}`);
      return { at: "now", to: input.to, kind: input.kind, text: input.text };
    },
    notifyStaff: async (text) => ({ at: "now", to: "staff", kind: "staff", text }),
  };
}

async function withEnvironment(
  fn: (env: TestWorkflowEnvironment, sent: string[]) => Promise<void>,
): Promise<void> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const sent: string[] = [];
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("../src/workflows"),
      activities: fakeActivities(sent),
    });
    await worker.runUntil(() => fn(env, sent));
  } finally {
    await env.teardown();
  }
}

test("offers one at a time; first YES wins; later YES is refused", async () => {
  await withEnvironment(async (env, sent) => {
    const handle = await env.client.workflow.start(openingWorkflow, {
      workflowId: "one-winner",
      taskQueue: TASK_QUEUE,
      args: [opening],
    });

    // Client 3 jumps the queue: they haven't been offered it yet.
    const early = await handle.executeUpdate(clientReply, {
      args: [{ clientId: "c3", accepted: true }],
    });
    assert.equal(early.ok, false);

    const declined = await handle.executeUpdate(clientReply, {
      args: [{ clientId: "c1", accepted: false }],
    });
    assert.equal(declined.ok, true);

    // Wait until the Workflow has moved on to client 2.
    let status: OpeningStatus;
    do {
      status = await handle.query(getOpeningStatus);
    } while (status.currentOffer?.clientId !== "c2");

    const won = await handle.executeUpdate(clientReply, {
      args: [{ clientId: "c2", accepted: true }],
    });
    assert.equal(won.ok, true);

    const result = await handle.result();
    assert.equal(result.phase, "filled");
    assert.equal(result.acceptedBy?.id, "c2");
    assert.deepEqual(
      result.offers.map((o) => `${o.clientId}:${o.outcome}`),
      ["c1:declined", "c2:accepted"],
    );
    // Client 1 was contacted, so they hear it's filled. Client 3 never was.
    assert.deepEqual(sent, ["offer:555-0101", "offer:555-0102", "filled:555-0101"]);

    const late = await handle.executeUpdate(clientReply, {
      args: [{ clientId: "c1", accepted: true }],
    }).catch(() => ({ ok: false }));
    assert.equal(late.ok, false);
  });
});

test("a client who doesn't reply times out and the offer moves on", async () => {
  await withEnvironment(async (env) => {
    const handle = await env.client.workflow.start(openingWorkflow, {
      workflowId: "timeout",
      taskQueue: TASK_QUEUE,
      args: [opening],
    });
    // Time-skipping: 15 minutes pass per client without anyone answering.
    const result = await handle.result();
    assert.equal(result.phase, "unfilled");
    assert.deepEqual(
      result.offers.map((o) => o.outcome),
      ["timed_out", "timed_out", "timed_out"],
    );
  });
});

test("staff can cancel while an offer is out", async () => {
  await withEnvironment(async (env, sent) => {
    const handle = await env.client.workflow.start(openingWorkflow, {
      workflowId: "cancel",
      taskQueue: TASK_QUEUE,
      args: [opening],
    });
    let status: OpeningStatus;
    do {
      status = await handle.query(getOpeningStatus);
    } while (status.phase !== "offering");

    await handle.signal(cancelOpening, "Original client un-cancelled.");
    const result = await handle.result();
    assert.equal(result.phase, "cancelled");
    assert.equal(result.offers[0].outcome, "withdrawn");
    assert.ok(sent.includes("withdrawn:555-0101"));
  });
});
