import {
  InvalidStaticPayloadPathError,
  readStaticPayloadInput,
} from "../../export/staticPayloadInput.ts";

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export default defineEventHandler(async (event) => {
  const runtimeConfig = useRuntimeConfig(event);
  const requestPath = getRouterParam(event, "path");
  if (
    runtimeConfig.viewerMode !== "static" ||
    runtimeConfig.staticPublicInput === "" ||
    requestPath === undefined
  ) {
    throw createError({ statusCode: 404, statusMessage: "Static payload not found" });
  }
  try {
    return await readStaticPayloadInput(runtimeConfig.staticPublicInput, requestPath);
  } catch (error) {
    if (error instanceof InvalidStaticPayloadPathError || isMissingFile(error)) {
      throw createError({ statusCode: 404, statusMessage: "Static payload not found" });
    }
    throw error;
  }
});
