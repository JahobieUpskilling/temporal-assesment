// A client who asked for an earlier appointment. In the salon today this is a
// row in the Google Sheet; the prototype uses a simulated copy (src/waitlist.ts).
export type WaitlistClient = {
  id: string;
  name: string;
  phone: string;
  service: string;
  serviceMinutes: number;
  preferredStylist: string | null;
  // Times of day the client said they can come in ("HH:MM", 24h).
  availableFrom: string;
  availableTo: string;
  joinedWaitlistAt: string;
};

// A gap in the schedule after a cancellation. Square stays the source of truth
// for appointments; staff enter the opening here by hand.
export type OpeningInput = {
  stylist: string;
  service: string | null; // null = any service that fits the gap
  startsAt: string; // ISO timestamp of the opening
  startsAtLabel: string; // human-readable local time, used in client texts
  lengthMinutes: number;
  replyWindowSeconds: number; // Lena: 15 minutes per person
  stopOfferingMinutesBefore: number; // Lena: "too close to be useful", no exact cutoff yet
  simulateTextFailure: boolean; // Demo only: the first text attempt fails so the retry is visible
};

export type OfferOutcome =
  | "offered"
  | "accepted"
  | "declined"
  | "timed_out"
  | "skipped"
  | "withdrawn";

export type OfferRecord = {
  clientId: string;
  clientName: string;
  offeredAt: string;
  expiresAt: string;
  outcome: OfferOutcome;
  respondedAt?: string;
};

export type MessageRecord = {
  at: string;
  to: string;
  kind: "offer" | "filled" | "withdrawn" | "staff";
  text: string;
};

// A reply that arrived for someone who no longer holds the offer.
export type LateReply = {
  clientId: string;
  clientName: string;
  at: string;
  accepted: boolean;
  result: string;
};

export type OpeningPhase = "matching" | "offering" | "filled" | "unfilled" | "cancelled";

export type OpeningStatus = {
  openingId: string;
  opening: OpeningInput;
  phase: OpeningPhase;
  reason: string;
  eligible: { id: string; name: string; service: string; joinedWaitlistAt: string }[];
  currentOffer: OfferRecord | null;
  offers: OfferRecord[];
  stillWaiting: { id: string; name: string }[];
  acceptedBy: { id: string; name: string; phone: string; service: string } | null;
  lateReplies: LateReply[];
  messages: MessageRecord[];
};

export type ReplyInput = { clientId: string; accepted: boolean };
export type ReplyResult = { ok: boolean; message: string };
