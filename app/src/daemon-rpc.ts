import superjson from "superjson";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { appRouter } from "@opentrader/trpc";

import { getSettings } from "./utils/settings.js";

export const createDaemonRpcClient = () => {
  const { host, port } = getSettings();

  const DAEMON_URL = `http://${host}:${port}/api/trpc`;

  return createTRPCProxyClient<typeof appRouter>({
    links: [
      httpBatchLink({
        url: DAEMON_URL,
        // v11: transformer lives on the link (client-root is ignored AND a type
        // error). Without this the client sends un-enveloped input and every
        // mutation 400s (S10 blocker, D47).
        transformer: superjson,
        headers: () => ({
          Authorization: process.env.ADMIN_PASSWORD,
        }),
      }),
    ],
  });
};
