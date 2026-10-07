import { ApplicationFailure, Context } from "@temporalio/activity";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { MessageRecord, OpeningInput, WaitlistClient } from "./types";
import { WAITLIST } from "./waitlist";

// Lena's rules for who fits an opening: the service has to fit the gap, the
// client has to be available at that time, and a requested stylist must match.
// Ordered by who joined the waitlist first.
export async function findEligibleClients(opening: OpeningInput): Promise<WaitlistClient[]> {
  const clock = localClock(opening.startsAt);
  const holds = readHolds();
  return WAITLIST.filter(
    (client) =>
      !holds[client.id]?.accepted && // already took another opening
      (opening.service === null || client.service === opening.service) &&
      client.serviceMinutes <= opening.lengthMinutes &&
      (client.preferredStylist === null || client.preferredStylist === opening.stylist) &&
      client.availableFrom <= clock &&
      clock < client.availableTo,
  ).sort((a, b) => a.joinedWaitlistAt.localeCompare(b.joinedWaitlistAt));
}

// Simulated SMS. A real integration (Twilio, Square Messages) would go here.
// Temporal retries this automatically, so a flaky provider never silently
// drops an offer. `simulateFailure` makes the first attempt fail on purpose so
// the retry is visible in the Web UI during the demo.
export async function sendText(input: {
  to: string;
  kind: MessageRecord["kind"];
  text: string;
  simulateFailure: boolean;
}): Promise<MessageRecord> {
  const { attempt } = Context.current().info;
  if (input.simulateFailure && attempt === 1) {
    throw new Error("Simulated SMS provider outage (attempt 1)");
  }
  const record: MessageRecord = {
    at: new Date().toISOString(),
    to: input.to,
    kind: input.kind,
    text: input.text,
  };
  console.log(`[sms → ${input.to}] ${input.text}`);
  return record;
}

// Staff notification. In the prototype this is just the server log plus the
// status page; in the salon it would be the salon phone or a Slack channel.
export async function notifyStaff(text: string): Promise<MessageRecord> {
  console.log(`[staff] ${text}`);
  return { at: new Date().toISOString(), to: "staff", kind: "staff", text };
}

function localClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw ApplicationFailure.nonRetryable(`Invalid opening time: ${iso}`);
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// A client may hold at most one offer at a time, and once they accept an
// opening they are no longer eligible for others. This simulates a "status"
// column on the spreadsheet; it lives in a small JSON file next to the app.
type Hold = { openingId: string; accepted: boolean };
const HOLDS_FILE = process.env.HOLDS_FILE ?? ".holds.json";
function readHolds(): Record<string, Hold> {
  return existsSync(HOLDS_FILE) ? (JSON.parse(readFileSync(HOLDS_FILE, "utf8")) as Record<string, Hold>) : {};
}
function writeHolds(holds: Record<string, Hold>): void {
  writeFileSync(HOLDS_FILE, JSON.stringify(holds, null, 2));
}
export async function claimClient(input: { clientId: string; openingId: string }): Promise<boolean> {
  const holds = readHolds();
  const current = holds[input.clientId];
  if (current && current.openingId !== input.openingId) return false;
  holds[input.clientId] = { openingId: input.openingId, accepted: false };
  writeHolds(holds);
  return true;
}
export async function releaseClient(input: { clientId: string; openingId: string; accepted: boolean }): Promise<void> {
  const holds = readHolds();
  if (holds[input.clientId]?.openingId !== input.openingId) return;
  if (input.accepted) holds[input.clientId] = { openingId: input.openingId, accepted: true };
  else delete holds[input.clientId];
  writeHolds(holds);
}
