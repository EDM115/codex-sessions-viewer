import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import {
  assertSafeOutputComponent,
  writeOutputFile,
  type OutputWriteDisposition,
} from "./outputFiles.ts";
import { serializeConversation } from "./serializeMarkdown.ts";

export interface WriteConversationExportOptions {
  generatedRoot: string;
  publicRoot?: string | undefined;
}

export interface ConversationExportResult {
  generated: OutputWriteDisposition;
  published: OutputWriteDisposition | null;
}

export async function writeConversationExport(
  conversation: NormalizedSession,
  options: WriteConversationExportOptions,
): Promise<ConversationExportResult> {
  const { id, scope } = conversation.summary;
  assertSafeOutputComponent(id);
  const markdown = serializeConversation(conversation);
  const generated = await writeOutputFile(
    options.generatedRoot,
    ["markdown", scope, `${id}.md`],
    markdown,
  );
  const published =
    options.publicRoot === undefined
      ? null
      : await writeOutputFile(options.publicRoot, ["downloads", scope, `${id}.md`], markdown);
  return { generated, published };
}
