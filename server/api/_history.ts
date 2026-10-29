import type { H3Event } from "h3";
import type * as z from "zod";

import { HistoryReloadError } from "#server/history/historyPager.ts";

export function historyQuery<T>(event: H3Event, schema: z.ZodType<T>): T {
  const encoded = getQuery(event)["history"];
  try {
    return schema.parse(
      typeof encoded === "string" ? JSON.parse(encoded) : { anchor: { kind: "latest" } },
    );
  } catch {
    throw createError({ statusCode: 400, statusMessage: "Invalid history query" });
  }
}

export function historyFailure(error: unknown): never {
  if (error instanceof Error && error.name === "AbortError") {
    throw createError({ statusCode: 499, statusMessage: "History request cancelled" });
  }
  if (error instanceof HistoryReloadError) {
    throw createError({
      statusCode: 409,
      statusMessage: "History changed, reload the selected window",
      data: { code: error.code, recoverable: true },
    });
  }
  if (error instanceof Error && error.message === "Session not found") {
    throw createError({ statusCode: 404, statusMessage: "Session not found" });
  }
  if (
    error instanceof Error &&
    /rollout.cache_owned_elsewhere|rollout.turn_unavailable|rollout.source_unresolved/u.test(
      error.message,
    )
  ) {
    throw createError({
      statusCode: 503,
      statusMessage: "History is temporarily unavailable",
      data: { code: error.message, recoverable: true },
    });
  }
  throw error;
}
