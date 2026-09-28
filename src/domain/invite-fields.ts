import { z } from "zod";

const text = z.string().max(500).default("");

export const inviteFieldsSchema = z.object({
  event: z.enum(["marriage", "reception", "birthday", "anniversary", "engagement", "housewarming", "baptism"]),
  hosts: text,
  names: z.string().trim().min(1).max(200),
  title: text,
  detail: text,
  date: z.string().min(8).max(20),
  time: text,
  venue: text,
  address: z.string().max(500).default(""),
  message: z.string().max(2000).default(""),
  dress: text,
  rsvpBy: text,
  hostEmail: text,
  receptionTime: text,
  receptionVenue: text,
  receptionAddress: z.string().max(500).default(""),
  photos: z.array(z.string().max(300)).max(16).default([]),
  audio: z.string().max(300).default(""),
  lat: text,
  lng: text,
  lines: z.string().max(8000).default(""),
});

export type InviteFields = z.infer<typeof inviteFieldsSchema>;
