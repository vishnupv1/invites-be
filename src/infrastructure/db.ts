import mongoose from "mongoose";
import { config } from "../config.js";

export function connectDb() {
  return mongoose.connect(config.mongoUri);
}
