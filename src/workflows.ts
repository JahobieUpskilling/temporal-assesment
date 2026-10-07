import {
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  OfferRecord,
  OpeningInput,
  OpeningStatus,
  ReplyInput,
  ReplyResult,
  WaitlistClient,
} from "./types";

const { findEligibleClients, sendText, notifyStaff, claimClient, releaseClient } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 5 },
});

// Client replies come in as an Update so the caller learns immediately whether
// their "yes" actually won the slot. Only the current offer holder can accept;
// everyone else gets a polite "already filled / moved on" answer.
export const clientReply = defineUpdate<ReplyResult, [ReplyInput]>("clientReply");
// Staff controls.
export const skipCurrent = defineSignal("skipCurrent");
export const cancelOpening = defineSignal<[string]>("cancelOpening");
export const getOpeningStatus = defineQuery<OpeningStatus>("getOpeningStatus");

// One Workflow per cancelled appointment. It offers the opening to eligible
// waitlist clients one at a time, in waitlist order, waits durably for each
// reply, and guarantees exactly one client can take the slot.
export async function openingWorkflow(opening: OpeningInput): Promise<OpeningStatus> {
  const status: OpeningStatus = {
    openingId: workflowInfo().workflowId,
    opening,
    phase: "matching",
    reason: "Finding waitlist clients who fit this opening.",
    eligible: [],
    currentOffer: null,
    offers: [],
    stillWaiting: [],
    acceptedBy: null,
    lateReplies: [],
    messages: [],
  };

  let pendingReply: ReplyInput | undefined;
  let skipRequested = false;
  let cancelReason: string | undefined;
  const cutoff = new Date(opening.startsAt).getTime() - opening.stopOfferingMinutesBefore * 60_000;

  setHandler(getOpeningStatus, () => status);
  setHandler(skipCurrent, () => {
    skipRequested = true;
  });
  setHandler(cancelOpening, (reason) => {
    cancelReason = reason || "Cancelled by staff.";
  });
  setHandler(clientReply, (reply) => {
    const current = status.currentOffer;
    const name = status.eligible.find((c) => c.id === reply.clientId)?.name ?? reply.clientId;
    const isHolder =
      status.phase === "offering" && current?.clientId === reply.clientId && !pendingReply;
    if (isHolder) {
      pendingReply = reply;
      return {
        ok: true,
        message: reply.accepted
          ? "You've got it! The salon will confirm your appointment shortly."
          : "No problem, we'll offer it to the next person.",
      };
    }
    const result = lateReplyMessage(status, reply);
    status.lateReplies.push({
      clientId: reply.clientId,
      clientName: name,
      at: new Date().toISOString(),
      accepted: reply.accepted,
      result,
    });
    return { ok: false, message: result };
  });

  const eligible = await findEligibleClients(opening);
  status.eligible = eligible.map(({ id, name, service, joinedWaitlistAt }) => ({
    id,
    name,
    service,
    joinedWaitlistAt,
  }));
  status.stillWaiting = eligible.map(({ id, name }) => ({ id, name }));

  if (eligible.length === 0) {
    return finish(status, "unfilled", "Nobody on the waitlist fits this opening.");
  }

  for (const client of eligible) {
    if (cancelReason) return finish(status, "cancelled", cancelReason);

    const now = Date.now();
    const windowMs = Math.min(opening.replyWindowSeconds * 1_000, cutoff - now);
    if (windowMs <= 0) {
      return finish(status, "unfilled", "Too close to the appointment to keep offering it.");
    }

    status.stillWaiting = status.stillWaiting.filter((c) => c.id !== client.id);
    // One offer per client at a time across all openings.
    if (!(await claimClient({ clientId: client.id, openingId: status.openingId }))) {
      status.offers.push({
        clientId: client.id,
        clientName: client.name,
        offeredAt: new Date(now).toISOString(),
        expiresAt: new Date(now).toISOString(),
        outcome: "busy",
      });
      continue;
    }
    const offer: OfferRecord = {
      clientId: client.id,
      clientName: client.name,
      offeredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + windowMs).toISOString(),
      outcome: "offered",
    };
    status.offers.push(offer);
    status.currentOffer = offer;
    status.phase = "offering";
    status.reason = `Waiting for ${client.name} to reply.`;
    pendingReply = undefined;
    skipRequested = false;

    status.messages.push(
      await sendText({
        to: client.phone,
        kind: "offer",
        text: offerText(client, opening, windowMs),
        simulateFailure: opening.simulateTextFailure && status.offers.length === 1,
      }),
    );

    const answered = await condition(
      () => pendingReply !== undefined || skipRequested || cancelReason !== undefined,
      windowMs,
    );

    // Snapshot: the handlers mutate these while we were awaiting, which TS's
    // narrowing can't see.
    const reply = pendingReply as ReplyInput | undefined;
    offer.respondedAt = new Date().toISOString();
    await releaseClient({ clientId: client.id, openingId: status.openingId, accepted: reply?.accepted === true && !cancelReason });
    if (cancelReason) {
      offer.outcome = "withdrawn";
      status.messages.push(
        await sendText({
          to: client.phone,
          kind: "withdrawn",
          text: `Juniper Salon: sorry, that ${opening.stylist} opening is no longer available. We'll keep you on the waitlist.`,
          simulateFailure: false,
        }),
      );
      return finish(status, "cancelled", cancelReason);
    }
    if (reply?.accepted) {
      offer.outcome = "accepted";
      status.acceptedBy = {
        id: client.id,
        name: client.name,
        phone: client.phone,
        service: client.service,
      };
      status.currentOffer = null;
      await tellOthersItsFilled(status, eligible, client.id);
      return finish(
        status,
        "filled",
        `${client.name} accepted. Staff: book it in Square and move their original appointment.`,
      );
    }
    if (reply) offer.outcome = "declined";
    else if (skipRequested) offer.outcome = "skipped";
    else if (!answered) offer.outcome = "timed_out";
    status.currentOffer = null;
  }

  return finish(status, "unfilled", "Everyone eligible was contacted; nobody accepted.");

  async function finish(
    s: OpeningStatus,
    phase: OpeningStatus["phase"],
    reason: string,
  ): Promise<OpeningStatus> {
    s.phase = phase;
    s.reason = reason;
    s.currentOffer = null;
    const prefix = { filled: "FILLED", unfilled: "UNFILLED", cancelled: "CANCELLED" }[
      phase as "filled" | "unfilled" | "cancelled"
    ];
    s.messages.push(
      await notifyStaff(`${prefix}: ${opening.stylist} ${opening.startsAtLabel} — ${reason}`),
    );
    return s;
  }

  async function tellOthersItsFilled(
    s: OpeningStatus,
    clients: WaitlistClient[],
    winnerId: string,
  ): Promise<void> {
    const contacted = s.offers.filter((o) => o.clientId !== winnerId);
    for (const offer of contacted) {
      const client = clients.find((c) => c.id === offer.clientId);
      if (!client) continue;
      s.messages.push(
        await sendText({
          to: client.phone,
          kind: "filled",
          text: `Juniper Salon: that opening has been filled. You're still on our waitlist for the next one.`,
          simulateFailure: false,
        }),
      );
    }
  }
}

function offerText(client: WaitlistClient, opening: OpeningInput, windowMs: number): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  return (
    `Juniper Salon: hi ${client.name.split(" ")[0]}, a ${opening.lengthMinutes}-minute opening ` +
    `with ${opening.stylist} just came up at ${opening.startsAtLabel}. Reply YES to take it or NO to pass. ` +
    `It's yours for the next ${minutes} min, then we'll offer it to the next person.`
  );
}

// Also used by the API when a reply arrives after the Workflow has finished.
export function lateReplyMessage(status: OpeningStatus, reply: ReplyInput): string {
  if (status.phase === "filled") {
    return "Sorry, that opening was already taken. You're still on the waitlist.";
  }
  if (status.phase === "cancelled") return "That opening is no longer available.";
  if (status.phase === "unfilled") return "That opening has closed.";
  const earlier = status.offers.find((o) => o.clientId === reply.clientId);
  if (earlier?.outcome === "busy") {
    return "You're already holding another opening with us; reply to that one first.";
  }
  if (earlier && earlier.outcome !== "offered") {
    return `Sorry, your ${Math.round(
      (new Date(earlier.expiresAt).getTime() - new Date(earlier.offeredAt).getTime()) / 60_000,
    )}-minute window ended and we've offered it to the next person.`;
  }
  if (earlier?.outcome === "offered") return "We already have your reply, thanks!";
  return "We haven't offered you this opening yet. We'll text you if it's your turn.";
}
