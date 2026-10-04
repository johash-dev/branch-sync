import { createApp } from "./app.js";
const { app } = createApp(undefined, () => process.exit(0));
const port = Number(process.env.SYNC_PORT || 4317);
await app.listen({ host: "127.0.0.1", port });
