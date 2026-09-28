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
  notes: z.string().max(8000).default(""),
  audio: z.string().max(300).default(""),
  lat: text,
  lng: text,
  lines: z.string().max(8000).default(""),
});

export const draftFieldsSchema = inviteFieldsSchema.extend({
  names: z.string().trim().max(200).default(""),
  date: z.string().max(20).default(""),
});

export const editorStateSchema = z
  .object({
    swatch: z.string().max(40).default(""),
    receptionOn: z.boolean().default(false),
    sections: z.array(z.object({ id: z.string().max(40), on: z.boolean() })).max(40).default([]),
  })
  .partial();

export type InviteFields = z.infer<typeof inviteFieldsSchema>;
export type EditorState = z.infer<typeof editorStateSchema>;
