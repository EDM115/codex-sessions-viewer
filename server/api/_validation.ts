import {
  createError,
  getHeader,
  getRequestHost,
  getValidatedQuery,
  getValidatedRouterParams,
  type H3Event,
} from "h3";
import * as z from "zod";

import {
  deepSearchRequestSchema,
  inspectorTargetSchema,
  preparationRequestSchema,
  type InspectorTarget,
  type SearchQuery,
  type SessionListQuery,
  type TurnChunkQuery,
} from "../../shared/types/repository.ts";
import {
  validateSearchQuery,
  validateSessionListQuery,
  validateTurnChunkQuery,
} from "../live/queryValidation.ts";

const idSchema = z.string().min(1).max(512);
const sessionParamsSchema = z.strictObject({ id: idSchema });
const assetParamsSchema = z.strictObject({ assetId: idSchema });
const faviconParamsSchema = z.strictObject({ originKey: z.string().regex(/^[\w-]{1,2048}$/u) });
const deepSearchParamsSchema = z.strictObject({ id: idSchema });
const apiInspectorQuerySchema = inspectorTargetSchema;

export function validator<T>(schema: z.ZodType<T>): (value: unknown) => T | false {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : false;
  };
}

export const validatePreparationBody = validator(preparationRequestSchema);
export const validateDeepSearchBody = validator(deepSearchRequestSchema);

export async function deepSearchId(event: H3Event): Promise<string> {
  return (
    await getValidatedRouterParams(event, validator(deepSearchParamsSchema), { decode: true })
  ).id;
}

export async function sessionId(event: H3Event): Promise<string> {
  return (await getValidatedRouterParams(event, validator(sessionParamsSchema), { decode: true }))
    .id;
}

export async function assetId(event: H3Event): Promise<string> {
  return (await getValidatedRouterParams(event, validator(assetParamsSchema), { decode: true }))
    .assetId;
}

export async function faviconKey(event: H3Event): Promise<string> {
  return (await getValidatedRouterParams(event, validator(faviconParamsSchema), { decode: true }))
    .originKey;
}

export function sessionListQuery(event: H3Event): Promise<SessionListQuery> {
  return getValidatedQuery(event, validateSessionListQuery);
}

export function searchQuery(event: H3Event): Promise<SearchQuery> {
  return getValidatedQuery(event, validateSearchQuery);
}

export function turnChunkQuery(event: H3Event): Promise<TurnChunkQuery> {
  return getValidatedQuery(event, validateTurnChunkQuery);
}

export function inspectorTarget(event: H3Event): Promise<InspectorTarget> {
  return getValidatedQuery(event, validator(apiInspectorQuerySchema));
}

export function assertSameOriginMutation(event: H3Event): void {
  if (getHeader(event, "sec-fetch-site") === "cross-site") {
    throw createError({ statusCode: 403, statusMessage: "Cross-origin request rejected" });
  }
  const origin = getHeader(event, "origin");
  if (origin === undefined) {
    return;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw createError({ statusCode: 403, statusMessage: "Invalid request origin" });
  }
  const host = getRequestHost(event, { xForwardedHost: false });
  if (originUrl.protocol !== "http:" || originUrl.host.toLowerCase() !== host.toLowerCase()) {
    throw createError({ statusCode: 403, statusMessage: "Cross-origin request rejected" });
  }
}

export function notFound(message: string): never {
  throw createError({ statusCode: 404, statusMessage: message });
}
