import mongoose, { Schema } from "mongoose";

const HostSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    passwordHash: { type: String },
    tokenHash: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);

const PurchaseSchema = new Schema(
  {
    hostId: { type: Schema.Types.ObjectId, ref: "Host", required: true },
    templateId: { type: String, required: true },
    price: { type: Number, required: true },
  },
  { timestamps: true },
);
PurchaseSchema.index({ hostId: 1, templateId: 1 }, { unique: true });

const InviteSchema = new Schema(
  {
    hostId: { type: Schema.Types.ObjectId, ref: "Host", required: true },
    templateId: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    names: { type: String, required: true },
    title: { type: String, default: "" },
    date: { type: String, required: true },
    fields: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

const GreetingSchema = new Schema(
  {
    inviteId: { type: Schema.Types.ObjectId, ref: "Invite", required: true, index: true },
    name: { type: String, required: true },
    note: { type: String, default: "" },
    attending: { type: Boolean, required: true },
  },
  { timestamps: true },
);

const MediaSchema = new Schema(
  {
    hostId: { type: Schema.Types.ObjectId, ref: "Host", required: true },
    filename: { type: String, required: true },
    mime: { type: String, required: true },
  },
  { timestamps: true },
);

export const HostModel = mongoose.model("Host", HostSchema);
export const PurchaseModel = mongoose.model("Purchase", PurchaseSchema);
export const InviteModel = mongoose.model("Invite", InviteSchema);
export const GreetingModel = mongoose.model("Greeting", GreetingSchema);
export const MediaModel = mongoose.model("Media", MediaSchema);
