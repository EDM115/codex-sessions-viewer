import * as z from "zod";

import {
  searchQuerySchema,
  sessionListQuerySchema,
  turnChunkQuerySchema,
  type SearchQuery,
  type SessionListQuery,
  type TurnChunkQuery,
} from "../../shared/types/repository.ts";

const booleanQuerySchema = z.enum(["true", "false"]).transform((value) => value === "true");
const pageLimitQuerySchema = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.int().min(1).max(200));
const apiSessionListQuerySchema = sessionListQuerySchema
  .omit({ hasMedia: true, limit: true })
  .extend({
    hasMedia: booleanQuerySchema.optional(),
    limit: pageLimitQuerySchema.optional(),
  });
const apiSearchQuerySchema = apiSessionListQuerySchema.extend({
  query: searchQuerySchema.shape.query,
});
const apiTurnChunkQuerySchema = turnChunkQuerySchema.omit({ limit: true }).extend({
  limit: pageLimitQuerySchema.optional(),
});

function validator<T>(schema: z.ZodType<T>): (value: unknown) => T | false {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : false;
  };
}

export const validateSessionListQuery = validator<SessionListQuery>(apiSessionListQuerySchema);
export const validateSearchQuery = validator<SearchQuery>(apiSearchQuerySchema);
export const validateTurnChunkQuery = validator<TurnChunkQuery>(apiTurnChunkQuerySchema);
