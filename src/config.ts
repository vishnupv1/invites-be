export const config = {
  port: Number(process.env.PORT ?? 4010),
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/vellum",
  corsOrigin: process.env.CORS_ORIGIN ?? true,
};
