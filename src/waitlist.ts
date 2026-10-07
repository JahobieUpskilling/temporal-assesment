import type { WaitlistClient } from "./types";

// Simulated copy of the salon's Google Sheet waitlist. Phone numbers are fake.
// In production this would be read from the sheet (or Square) by an Activity.
export const WAITLIST: WaitlistClient[] = [
  {
    id: "c1",
    name: "Priya N.",
    phone: "555-0101",
    service: "Cut",
    serviceMinutes: 45,
    preferredStylist: null,
    availableFrom: "09:00",
    availableTo: "17:00",
    joinedWaitlistAt: "2026-09-28T10:15:00Z",
  },
  {
    id: "c2",
    name: "Marcus D.",
    phone: "555-0102",
    service: "Cut",
    serviceMinutes: 45,
    preferredStylist: "Carla",
    availableFrom: "12:00",
    availableTo: "18:00",
    joinedWaitlistAt: "2026-09-29T08:40:00Z",
  },
  {
    id: "c3",
    name: "Elena R.",
    phone: "555-0103",
    service: "Colour",
    serviceMinutes: 120,
    preferredStylist: "Lena",
    availableFrom: "09:00",
    availableTo: "15:00",
    joinedWaitlistAt: "2026-09-30T14:05:00Z",
  },
  {
    id: "c4",
    name: "Sam K.",
    phone: "555-0104",
    service: "Trim",
    serviceMinutes: 30,
    preferredStylist: null,
    availableFrom: "10:00",
    availableTo: "19:00",
    joinedWaitlistAt: "2026-10-01T09:30:00Z",
  },
  {
    id: "c5",
    name: "Jordan P.",
    phone: "555-0105",
    service: "Cut",
    serviceMinutes: 45,
    preferredStylist: "Lena",
    availableFrom: "08:00",
    availableTo: "12:00",
    joinedWaitlistAt: "2026-10-02T16:20:00Z",
  },
  {
    id: "c6",
    name: "Aisha M.",
    phone: "555-0106",
    service: "Blowout",
    serviceMinutes: 40,
    preferredStylist: null,
    availableFrom: "09:00",
    availableTo: "20:00",
    joinedWaitlistAt: "2026-10-03T11:00:00Z",
  },
];

export const STYLISTS = ["Lena", "Carla"];
