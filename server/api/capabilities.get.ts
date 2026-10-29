import { useLiveViewerRuntime } from "#server/live/requestContext.ts";

export default defineEventHandler((event) => useLiveViewerRuntime(event).repository.capabilities());
