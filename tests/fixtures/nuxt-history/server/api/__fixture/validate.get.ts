import * as z from "zod";

import {
  validateSearchQuery,
  validateSessionListQuery,
  validateTurnChunkQuery,
} from "#server/live/queryValidation.ts";

export default defineEventHandler((event) =>
  getValidatedQuery(event, (query) => {
    const parsed = z.record(z.string(), z.unknown()).safeParse(query);
    if (!parsed.success) {
      return false;
    }
    const { kind, ...parameters } = parsed.data;
    return kind === "search"
      ? validateSearchQuery(parameters)
      : kind === "turn"
        ? validateTurnChunkQuery(parameters)
        : validateSessionListQuery(parameters);
  }),
);
