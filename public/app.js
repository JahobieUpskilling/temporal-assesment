const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let lastRendered = "";
const form = $("#new-opening");
const openingsEl = $("#openings");
const clientSelect = $("#client-select");
const inbox = $("#inbox");
const replyResult = $("#reply-result");

let waitlist = { stylists: [], clients: [] };
let openings = [];
// The opening the client phone replies to: the newest one that is still open,
// or the one the staff picked with "Reply as client".
let selectedOpeningId = localStorage.getItem("selectedOpeningId");
let selectedAt = 0;

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409) {
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return body;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

function secondsLeft(iso) {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
}

const OUTCOME_LABEL = {
  offered: "waiting",
  accepted: "accepted ✓",
  declined: "declined",
  timed_out: "no reply (timed out)",
  skipped: "skipped by staff",
  withdrawn: "withdrawn",
  busy: "holding another offer / already booked",
};

function renderOpening(o) {
  const current = o.currentOffer;
  const open = o.phase === "matching" || o.phase === "offering";
  return `
  <article class="card opening phase-${o.phase}" data-testid="opening" data-opening-id="${o.openingId}">
    <div class="opening-head">
      <div>
        <span class="badge ${o.phase}" data-testid="phase">${o.phase}</span>
        <strong>${esc(o.opening.stylist)}</strong> · ${fmtTime(o.opening.startsAt)} · ${o.opening.lengthMinutes} min${o.opening.service ? ` · ${esc(o.opening.service)}` : ""}
      </div>
      <code class="muted">${o.openingId}</code>
    </div>
    <p class="reason" data-testid="reason">${esc(o.reason)}</p>
    ${
      current
        ? `<div class="current" data-testid="current-offer">
            <strong>${esc(current.clientName)}</strong> has the offer ·
            <span class="countdown" data-expires="${current.expiresAt}" data-testid="countdown">${secondsLeft(
              current.expiresAt,
            )}s</span> left
          </div>`
        : ""
    }
    ${
      o.acceptedBy
        ? `<div class="accepted" data-testid="accepted-by">
            <strong>${esc(o.acceptedBy.name)}</strong> (${esc(o.acceptedBy.phone)}) takes it for a ${esc(o.acceptedBy.service)}.
            <br /><em>Next: book it in Square and move their original appointment. Decide whether they stay on the waitlist.</em>
          </div>`
        : ""
    }
    <div class="lists">
      <div>
        <h4>Contacted</h4>
        <ol data-testid="offers">
          ${o.offers
            .map(
              (f) =>
                `<li class="outcome-${f.outcome}"><span>${esc(f.clientName)}</span> <small>${OUTCOME_LABEL[f.outcome]}</small></li>`,
            )
            .join("") || "<li class='muted'>nobody yet</li>"}
        </ol>
      </div>
      <div>
        <h4>Still waiting</h4>
        <ul data-testid="still-waiting">
          ${o.stillWaiting.map((c) => `<li>${esc(c.name)}</li>`).join("") || "<li class='muted'>none</li>"}
        </ul>
      </div>
      <div>
        <h4>Late / invalid replies</h4>
        <ul data-testid="late-replies">
          ${o.lateReplies
            .map((r) => `<li>${esc(r.clientName)} said ${r.accepted ? "YES" : "NO"} → <small>${esc(r.result)}</small></li>`)
            .join("") || "<li class='muted'>none</li>"}
        </ul>
      </div>
    </div>
    <details>
      <summary>Messages sent (${o.messages.length})</summary>
      <ul class="messages" data-testid="messages">
        ${o.messages.map((m) => `<li><small>${fmtTime(m.at)} → ${esc(m.to)}</small><br />${esc(m.text)}</li>`).join("")}
      </ul>
    </details>
    <div class="actions">
      <button class="ghost" data-action="select" ${selectedOpeningId === o.openingId ? "disabled" : ""}>
        ${selectedOpeningId === o.openingId ? "Phone is replying to this" : "Reply as client"}
      </button>
      <button data-action="skip" data-testid="skip" ${o.phase === "offering" ? "" : "disabled"}>Skip current</button>
      <button class="danger" data-action="cancel" data-testid="cancel" ${open ? "" : "disabled"}>Cancel opening</button>
    </div>
  </article>`;
}

function renderInbox() {
  const client = waitlist.clients.find((c) => c.id === clientSelect.value);
  const opening = openings.find((o) => o.openingId === (client ? openingForClient(client.id) : selectedOpeningId));
  if (!client || !opening) {
    inbox.innerHTML = selectedOpeningId
      ? `<p class="muted">Loading <code>${selectedOpeningId}</code>…</p>`
      : `<p class="muted">No opening selected. Start one, or pick one with "Reply as client".</p>`;
    return;
  }
  const texts = opening.messages.filter((m) => m.to === client.phone);
  inbox.innerHTML =
    `<p class="muted">Replying to <code>${opening.openingId}</code></p>` +
    (texts.map((m) => `<div class="bubble" data-testid="sms">${esc(m.text)}</div>`).join("") ||
      `<p class="muted">No texts yet for ${client.name}.</p>`);
}

function render() {
  // Re-render only when something changed, so open <details> etc. stay put.
  const snapshot = JSON.stringify([openings, selectedOpeningId, clientSelect.value]);
  if (snapshot === lastRendered) return;
  lastRendered = snapshot;
  const openDetails = new Set(
    [...openingsEl.querySelectorAll("details[open]")].map((d) => d.closest("[data-opening-id]")?.dataset.openingId),
  );
  openingsEl.innerHTML =
    openings.map(renderOpening).join("") ||
    `<p class="muted card">No openings yet. Enter one above when a cancellation comes in.</p>`;
  for (const id of openDetails) {
    const details = openingsEl.querySelector(`[data-opening-id="${id}"] details`);
    if (details) details.open = true;
  }
  renderInbox();
}

async function refresh() {
  openings = await api("/api/openings");
  // Only pick a default when nothing is selected. A just-started opening can
  // take a moment to show up in the list, so never override an explicit choice.
  // A stale selection from a previous session (not in the list, and not just created) is dropped.
  if (selectedOpeningId && !openings.some((o) => o.openingId === selectedOpeningId) && Date.now() - selectedAt > 10_000) {
    selectedOpeningId = null;
  }
  if (!selectedOpeningId) {
    selectedOpeningId = openings.find((o) => o.phase === "offering" || o.phase === "matching")?.openingId ?? null;
  }
  render();
}

function tickCountdowns() {
  for (const el of document.querySelectorAll(".countdown")) {
    el.textContent = `${secondsLeft(el.dataset.expires)}s`;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const body = {
    stylist: data.stylist,
    service: data.service || null,
    startsAt: new Date(data.startsAt).toISOString(),
    lengthMinutes: Number(data.lengthMinutes),
    replyWindowSeconds: Number(data.replyWindowSeconds),
    stopOfferingMinutesBefore: Number(data.stopOfferingMinutesBefore),
    simulateTextFailure: data.simulateTextFailure === "on",
  };
  const { openingId } = await api("/api/openings", { method: "POST", body: JSON.stringify(body) });
  selectedOpeningId = openingId;
  selectedAt = Date.now();
  localStorage.setItem("selectedOpeningId", openingId);
  replyResult.textContent = "";
  await refresh();
});

$("#reset-holds").addEventListener("click", async () => {
  await fetch("/api/holds/reset", { method: "POST" });
  replyResult.textContent = "All clients are eligible again.";
  replyResult.className = "reply-result ok";
});

$("#demo-window").addEventListener("click", () => {
  $("#replyWindow").value = 20;
});

openingsEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const openingId = button.closest("[data-opening-id]").dataset.openingId;
  if (button.dataset.action === "select") {
    selectedOpeningId = openingId;
    selectedAt = Date.now();
    localStorage.setItem("selectedOpeningId", openingId);
    render();
    return;
  }
  if (button.dataset.action === "cancel") {
    const reason = prompt("Why is this opening being cancelled?", "Original client changed their mind.");
    if (reason === null) return;
    await api(`/api/openings/${openingId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
  } else {
    await api(`/api/openings/${openingId}/skip`, { method: "POST" });
  }
  await refresh();
});

// The opening this client's reply belongs to: the one they currently hold,
// otherwise the selected one (so late/invalid replies still get an answer).
function openingForClient(clientId) {
  const held = openings.find((o) => o.phase === "offering" && o.currentOffer?.clientId === clientId);
  return held?.openingId ?? selectedOpeningId;
}

async function reply(accepted) {
  const target = openingForClient(clientSelect.value);
  if (!target) return;
  const result = await api(`/api/openings/${target}/reply`, {
    method: "POST",
    body: JSON.stringify({ clientId: clientSelect.value, accepted }),
  });
  replyResult.textContent = result.message;
  replyResult.className = `reply-result ${result.ok ? "ok" : "refused"}`;
  await refresh();
}
$("#reply-yes").addEventListener("click", () => reply(true).catch(showError));
$("#reply-no").addEventListener("click", () => reply(false).catch(showError));
clientSelect.addEventListener("change", () => {
  replyResult.textContent = "";
  renderInbox();
});

function showError(error) {
  console.error(error);
  replyResult.textContent = error.message;
  replyResult.className = "reply-result refused";
}

async function init() {
  waitlist = await api("/api/waitlist");
  $("#stylist").innerHTML = waitlist.stylists.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#service").innerHTML =
    `<option value="">Any that fits</option>` + waitlist.services.map((s) => `<option>${esc(s)}</option>`).join("");
  clientSelect.innerHTML = waitlist.clients
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.phone)})</option>`)
    .join("");
  $("#waitlist").innerHTML =
    `<tr><th>Joined</th><th>Name</th><th>Service</th><th>Stylist</th><th>Available</th></tr>` +
    waitlist.clients
      .map(
        (c) =>
          `<tr><td>${new Date(c.joinedWaitlistAt).toLocaleDateString()}</td><td>${c.name}</td>` +
          `<td>${c.service} (${c.serviceMinutes}m)</td><td>${c.preferredStylist ?? "any"}</td>` +
          `<td>${c.availableFrom}–${c.availableTo}</td></tr>`,
      )
      .join("");
  // Default the opening to two hours from now, rounded to the next quarter
  // hour. Outside salon hours (9–6) use tomorrow at 10:00 so someone is eligible.
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  if (start.getHours() < 9 || start.getHours() >= 18) {
    if (start.getHours() >= 18) start.setDate(start.getDate() + 1);
    start.setHours(10, 0, 0, 0);
  }
  const pad = (n) => String(n).padStart(2, "0");
  $("#startsAt").value = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(
    start.getHours(),
  )}:${pad(start.getMinutes())}`;
  await refresh();
  setInterval(() => refresh().catch(console.error), 1000);
  setInterval(tickCountdowns, 250);
}

init().catch(showError);
