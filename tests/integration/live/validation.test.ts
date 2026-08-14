import { createServer } from "node:http";

import { createApp, defineEventHandler, getValidatedQuery, toNodeListener } from "h3";
import { describe, expect, it } from "vitest";

import {
  validateSearchQuery,
  validateSessionListQuery,
  validateTurnChunkQuery,
} from "../../../server/live/queryValidation.ts";

async function validatedQuery(
  query: string,
  validate: (value: unknown) => object | false,
): Promise<{ body: unknown; status: number }> {
  const app = createApp().use(
    defineEventHandler(async (event) => getValidatedQuery(event, validate)),
  );
  const server = createServer(toNodeListener(app));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The validation fixture did not bind a TCP port.");
    }
    const response = await fetch(`http://127.0.0.1:${String(address.port)}?${query}`);
    return { body: await response.json(), status: response.status };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}

describe("live API query validation", () => {
  it("coerces numeric list parameters from the HTTP query string", async () => {
    await expect(
      validatedQuery("scope=active&limit=10", validateSessionListQuery),
    ).resolves.toEqual({
      body: { scope: "active", limit: 10 },
      status: 200,
    });
  });

  it("coerces numeric turn-chunk parameters from the HTTP query string", async () => {
    await expect(validatedQuery("cursor=0&limit=20", validateTurnChunkQuery)).resolves.toEqual({
      body: { cursor: "0", limit: 20 },
      status: 200,
    });
  });

  it("coerces numeric search parameters from the HTTP query string", async () => {
    await expect(
      validatedQuery("scope=active&query=task&limit=5", validateSearchQuery),
    ).resolves.toEqual({
      body: { scope: "active", query: "task", limit: 5 },
      status: 200,
    });
  });
});
