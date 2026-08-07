import { buildApp } from "./app";
import { loadConfig } from "./config";
import { PostgresControlStore } from "./postgresStore";

const config = loadConfig();
const store = new PostgresControlStore(config.databaseUrl);
const app = await buildApp(config, store);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "graceful shutdown started");
  const timeout = setTimeout(() => process.exit(1), 12_000).unref();
  try {
    await app.close();
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, "graceful shutdown failed");
    process.exit(1);
  }
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ error }, "API startup failed");
  await app.close();
  process.exit(1);
}
