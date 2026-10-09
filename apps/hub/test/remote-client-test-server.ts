import { HubStore } from "../src/db.js";
import { createHubServer } from "../src/server.js";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("expected an ephemeral TCP port as the first argument");
}

const { server } = createHubServer({
  port,
  hostname: "127.0.0.1",
  store: new HubStore(":memory:"),
  publicURL: `ws://127.0.0.1:${port}/ws`,
});

process.stdout.write("ready\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop(true);
    process.exit(0);
  });
}
