import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import * as z from "zod";

import { assertSafeOutputComponent } from "#server/export/outputFiles.ts";
import { isThreadVisible } from "#server/metadata/threadClassification.ts";
import { selectFinalAssistantMessageId } from "#shared/timeline/finalAnswer.ts";
import {
  conversationSummarySchema,
  sha256Schema,
  type ConversationTurn,
} from "#shared/types/conversation.ts";
import { viewerDiagnosticSchema } from "#shared/types/diagnostics.ts";
import type { CatalogSessionMetadata } from "#shared/types/library.ts";
import { linkPreviewSchema } from "#shared/types/linkPreview.ts";
import {
  resolvedAssetSchema,
  turnChunkSchema,
  type InspectorRecord,
} from "#shared/types/repository.ts";
import {
  staticHistoryManifestSchema,
  staticHistoryChunkSchema,
} from "#shared/types/staticHistory.ts";
import {
  hydrateStaticInspectorRecords,
  staticInspectorChunkSchema,
  staticLibraryPayloadSchema,
  staticNavigatorPayloadSchema,
  staticSessionIndexSchema,
} from "#shared/types/staticPayloads.ts";

const exportManifestSchema = z.strictObject({
  version: z.literal(1),
  pagefind: z.boolean(),
});

const sessionIndexSchema = staticSessionIndexSchema;

const sessionSummarySchema = z.strictObject({
  summary: conversationSummarySchema,
  diagnostics: z.array(viewerDiagnosticSchema),
});

const assetManifestSchema = z.strictObject({
  version: z.literal(1),
  assets: z.array(resolvedAssetSchema),
});

const faviconManifestSchema = z.strictObject({
  version: z.literal(1),
  favicons: z.array(
    z.strictObject({
      origin: z.url(),
      url: z.string().startsWith("/favicons/"),
      sourceUrl: z.url().nullable(),
      mimeType: z.string().nullable(),
      byteSize: z.int().nonnegative().nullable(),
      sha256: sha256Schema,
    }),
  ),
});

export interface OutputVerificationSummary {
  publicRoot: string;
  sessionCount: number;
  turnCount: number;
  assetCount: number;
  faviconCount: number;
  searchIndex: boolean;
  checkedFiles: number;
}

export interface VerifyOutputArguments {
  output: string;
}

export function parseVerifyOutputArguments(args: readonly string[]): VerifyOutputArguments {
  if (args.length === 0) {
    return { output: ".output/public" };
  }
  const argument = args[0]!;
  let output: string;
  if (argument === "--output") {
    const value = args[1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--output requires a value");
    }
    output = value;
    if (args.length !== 2) {
      throw new Error(`Unknown option: ${args[2]}`);
    }
  } else if (argument.startsWith("--output=")) {
    output = argument.slice("--output=".length);
    if (output === "") {
      throw new Error("--output requires a value");
    }
    if (args.length !== 1) {
      throw new Error(`Unknown option: ${args[1]}`);
    }
  } else {
    throw new Error(`Unknown option: ${argument}`);
  }
  return { output };
}

interface VerifiedTree {
  files: Set<string>;
  htmlFiles: string[];
  cssFiles: string[];
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function inspectOutputTree(publicRoot: string): Promise<VerifiedTree> {
  const metadata = await lstat(publicRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Generated output root is not an unlinked directory: ${publicRoot}`);
  }
  const files = new Set<string>();
  const htmlFiles: string[] = [];
  const cssFiles: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      // oxlint-disable-next-line no-await-in-loop -- Every path must be checked before descending into or trusting it.
      const entryMetadata = await lstat(path);
      if (entryMetadata.isSymbolicLink()) {
        throw new Error(`Generated output contains a symbolic link: ${path}`);
      }
      if (entryMetadata.isDirectory()) {
        // oxlint-disable-next-line no-await-in-loop -- Deterministic traversal bounds open handles for large exports.
        await visit(path);
        continue;
      }
      if (!entryMetadata.isFile() || entryMetadata.nlink > 1) {
        throw new Error(`Generated output contains a non-regular or linked file: ${path}`);
      }
      const relativePath = portableRelative(publicRoot, path);
      files.add(relativePath);
      if (relativePath.endsWith(".html")) {
        htmlFiles.push(relativePath);
      } else if (relativePath.endsWith(".css")) {
        cssFiles.push(relativePath);
      }
    }
  };
  await visit(publicRoot);
  return { files, htmlFiles, cssFiles };
}

function requireFile(tree: VerifiedTree, path: string): void {
  if (!tree.files.has(path)) {
    throw new Error(`Generated output is missing required file: ${path}`);
  }
}

async function parseJson<T>(publicRoot: string, path: string, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(publicRoot, ...path.split("/")), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Generated output contains unreadable JSON: ${path}`, { cause: error });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Generated output contains invalid JSON: ${path}`, { cause: parsed.error });
  }
  return parsed.data;
}

function inspectorTargetKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function expectedInspectorTargets(turns: readonly ConversationTurn[]): string[] {
  return turns.flatMap((turn) => [
    inspectorTargetKey("turn", turn.id),
    ...(turn.userMessage === null ? [] : [inspectorTargetKey("message", turn.userMessage.id)]),
    ...(turn.steeringMessages ?? []).map((message) => inspectorTargetKey("message", message.id)),
    ...turn.assistantMessages.map((message) => inspectorTargetKey("message", message.id)),
    ...turn.activities.map((activity) => inspectorTargetKey("activity", activity.id)),
  ]);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Generated output contains duplicate ${label}.`);
  }
}

function assertEqualOrdered(
  left: readonly string[],
  right: readonly string[],
  message: string,
): void {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(message);
  }
}

function assertTurnOrdering(
  turn: ConversationTurn,
  path: string,
  inspectorRecords: InspectorRecord[],
): void {
  let completionText: string | null = null;
  const record = inspectorRecords.find(
    (entry) => entry.target.type === "turn" && entry.target.id === turn.id,
  );
  for (const raw of record?.rawRecords ?? []) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const envelope = raw["payload"];
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      continue;
    }
    const payload = envelope["payload"] ?? envelope;
    if (
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload["type"] === "task_complete" &&
      typeof payload["last_agent_message"] === "string"
    ) {
      completionText = payload["last_agent_message"];
    }
  }
  if (
    turn.finalAssistantMessageId !==
    selectFinalAssistantMessageId(turn.assistantMessages, completionText)
  ) {
    throw new Error(`Turn final assistant ID does not match qualified response evidence: ${path}`);
  }
  if (turn.entryOrder === undefined) {
    throw new Error(`Turn is missing chronological entry order: ${path}`);
  }
  const expectedEntries = [
    ...(turn.userMessage === null ? [] : [`message:${turn.userMessage.id}`]),
    ...(turn.steeringMessages ?? []).map(({ id }) => `message:${id}`),
    ...turn.assistantMessages.map(({ id }) => `message:${id}`),
    ...turn.activities.map(({ id }) => `activity:${id}`),
  ].toSorted();
  const actualEntries = turn.entryOrder.map(({ kind, id }) => `${kind}:${id}`);
  assertUnique(actualEntries, `turn entry references in ${path}`);
  assertEqualOrdered(
    actualEntries.toSorted(),
    expectedEntries,
    `Turn chronological entry order does not match its messages and activities: ${path}`,
  );
}

function assertLibraryTopology(
  sessions: readonly CatalogSessionMetadata[],
  library: z.infer<typeof staticLibraryPayloadSchema>,
): void {
  const summaries = new Map(sessions.map((summary) => [summary.id, summary]));
  const projectIds = new Set(
    (library.version === 1 ? library.projects : library.catalog.projects).map(({ id }) => id),
  );
  const entries =
    library.version === 1
      ? library.entries
      : Object.fromEntries(
          library.catalog.threads.map((thread) => [
            thread.id,
            {
              projectId: thread.projectId,
              classification: thread.classification,
              kind: isThreadVisible(thread.classification, "child") ? "subagent" : "root",
              parentThreadId: thread.classification.parentThreadId,
              childCount: library.catalog.threads.filter(
                (child) =>
                  isThreadVisible(child.classification, "child") &&
                  child.classification.parentThreadId === thread.id,
              ).length,
            },
          ]),
        );
  assertEqualOrdered(
    Object.keys(entries).toSorted(),
    [...summaries.keys()].toSorted(),
    "Generated project payload does not match the public session index.",
  );
  for (const summary of sessions) {
    const entry = entries[summary.id]!;
    if (entry.classification !== undefined && !isThreadVisible(entry.classification)) {
      throw new Error(
        `Internal or unresolved thread crossed the public output boundary: ${summary.id}`,
      );
    }
    if (entry.projectId !== null && !projectIds.has(entry.projectId)) {
      throw new Error(`Session references a missing generated project: ${summary.id}`);
    }
    if (
      entry.parentThreadId !== summary.parentThreadId ||
      (entry.classification !== undefined &&
        entry.kind !==
          (entry.classification.visibility === "delegated-child" ? "subagent" : "root")) ||
      entry.kind !== (summary.parentThreadId === null ? "root" : "subagent") ||
      entry.childCount !== summary.childThreadIds.length
    ) {
      throw new Error(
        `Generated project topology does not match the session summary: ${summary.id}`,
      );
    }
    if (summary.parentThreadId !== null) {
      const parent = summaries.get(summary.parentThreadId);
      if (parent !== undefined && !parent.childThreadIds.includes(summary.id)) {
        throw new Error(`Generated subagent is missing its parent edge: ${summary.id}`);
      }
    }
    for (const childId of summary.childThreadIds) {
      if (summaries.get(childId)?.parentThreadId !== summary.id) {
        throw new Error(`Generated session contains an inconsistent child edge: ${summary.id}`);
      }
    }
    const visited = new Set([summary.id]);
    let ancestorId = summary.parentThreadId;
    while (ancestorId !== null) {
      if (visited.has(ancestorId)) {
        throw new Error(`Generated subagent topology contains a cycle: ${summary.id}`);
      }
      visited.add(ancestorId);
      ancestorId = summaries.get(ancestorId)?.parentThreadId ?? null;
    }
  }
  for (const project of library.version === 1 ? library.projects : []) {
    const roots = sessions.filter(
      (summary) => summary.parentThreadId === null && entries[summary.id]?.projectId === project.id,
    );
    const activeCount = roots.filter(({ scope }) => scope === "active").length;
    const archivedCount = roots.filter(({ scope }) => scope === "archived").length;
    if (project.activeCount !== activeCount || project.archivedCount !== archivedCount) {
      throw new Error(`Generated project counts do not match root conversations: ${project.id}`);
    }
  }
}

async function verifySession(
  publicRoot: string,
  tree: VerifiedTree,
  indexedSummary: CatalogSessionMetadata,
): Promise<number> {
  const { id } = indexedSummary;
  assertSafeOutputComponent(id);
  const base = `payloads/sessions/${id}`;
  const summaryPayload = await parseJson(publicRoot, `${base}/summary.json`, sessionSummarySchema);
  if (
    summaryPayload.summary.id !== id ||
    summaryPayload.summary.scope !== indexedSummary.scope ||
    summaryPayload.summary.revision !== indexedSummary.revision
  ) {
    throw new Error(`Session summary does not match the session index: ${id}`);
  }
  if (summaryPayload.diagnostics.length !== summaryPayload.summary.diagnosticCount) {
    throw new Error(`Session diagnostics do not match the indexed diagnostic count: ${id}`);
  }
  const navigator = await parseJson(
    publicRoot,
    `${base}/navigator.json`,
    staticNavigatorPayloadSchema,
  );
  if (navigator.sessionId !== id || navigator.revision !== indexedSummary.revision) {
    throw new Error(`Session navigator does not match the indexed session: ${id}`);
  }
  if (navigator.items.length !== summaryPayload.summary.turnCount) {
    throw new Error(`Session navigator does not match the indexed turn count: ${id}`);
  }
  assertUnique(
    navigator.items.map(({ turnId }) => turnId),
    `turn IDs in navigator ${id}`,
  );
  for (const [index, item] of navigator.items.entries()) {
    if (item.index !== index) {
      throw new Error(`Session navigator contains a non-contiguous turn index: ${id}`);
    }
  }
  const chunkCount = navigator.chunkCount;
  const expectedNavigatorTurnIds = navigator.items.map(({ turnId }) => turnId);
  assertEqualOrdered(
    Object.keys(navigator.turnChunks).toSorted(),
    [...expectedNavigatorTurnIds].toSorted(),
    `Navigator turn chunk index does not match its turns: ${id}`,
  );
  if (
    (navigator.items.length === 0 && chunkCount !== 0) ||
    (navigator.items.length > 0 && chunkCount < 1) ||
    Object.values(navigator.turnChunks).some((chunk) => chunk >= chunkCount)
  ) {
    throw new Error(`Navigator turn chunk index is out of range: ${id}`);
  }
  const chunkTurnIds: string[] = [];
  const expectedTurnChunks: Record<string, number> = {};
  const expectedInspectorChunks: Record<string, number> = {};
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const turnPath = `${base}/turn-${chunkIndex}.json`;
    const inspectorPath = `${base}/inspector-${chunkIndex}.json`;
    // oxlint-disable-next-line no-await-in-loop -- One session chunk is validated and released before the next to bound verifier memory.
    const turnChunk = await parseJson(publicRoot, turnPath, turnChunkSchema);
    // oxlint-disable-next-line no-await-in-loop -- The paired inspector chunk must be validated alongside its turn chunk without retaining the archive.
    const inspectorChunk = await parseJson(publicRoot, inspectorPath, staticInspectorChunkSchema);
    const inspectorRecords = hydrateStaticInspectorRecords(inspectorChunk);
    const expectedPrevious = chunkIndex === 0 ? null : String(chunkIndex - 1);
    const expectedNext = chunkIndex === chunkCount - 1 ? null : String(chunkIndex + 1);
    if (
      turnChunk.sessionId !== id ||
      turnChunk.revision !== indexedSummary.revision ||
      turnChunk.previousCursor !== expectedPrevious ||
      turnChunk.nextCursor !== expectedNext ||
      turnChunk.turns.length > navigator.chunkSize
    ) {
      throw new Error(`Turn chunk metadata does not match the navigator: ${turnPath}`);
    }
    if (turnChunk.turns.length === 0) {
      throw new Error(`Turn chunks do not match the navigator: ${id}`);
    }
    for (const turn of turnChunk.turns) {
      if (turn.sessionId !== id) {
        throw new Error(`Turn chunk contains a turn from another session: ${turnPath}`);
      }
      assertTurnOrdering(turn, turnPath, inspectorRecords);
      chunkTurnIds.push(turn.id);
      expectedTurnChunks[turn.id] = chunkIndex;
    }
    if (inspectorChunk.sessionId !== id || inspectorChunk.revision !== indexedSummary.revision) {
      throw new Error(`Inspector chunk metadata does not match the session: ${inspectorPath}`);
    }
    const expectedTargets = expectedInspectorTargets(turnChunk.turns).toSorted();
    for (const target of expectedTargets) {
      expectedInspectorChunks[target] = chunkIndex;
    }
    const actualTargets = inspectorRecords
      .map((record) => {
        if (record.sessionId !== id) {
          throw new Error(
            `Inspector chunk contains a record from another session: ${inspectorPath}`,
          );
        }
        return inspectorTargetKey(record.target.type, record.target.id);
      })
      .toSorted();
    assertEqualOrdered(
      actualTargets,
      expectedTargets,
      `Inspector records do not match their turn chunk: ${inspectorPath}`,
    );
    const referencedRawRecords = new Set(inspectorRecords.flatMap(({ eventIds }) => eventIds));
    assertEqualOrdered(
      Object.keys(inspectorChunk.rawRecords).toSorted(),
      [...referencedRawRecords].toSorted(),
      `Inspector raw-record pool does not match its records: ${inspectorPath}`,
    );
    for (const [eventId, rawRecord] of Object.entries(inspectorChunk.rawRecords)) {
      if (
        typeof rawRecord !== "object" ||
        rawRecord === null ||
        Array.isArray(rawRecord) ||
        rawRecord["id"] !== eventId
      ) {
        throw new Error(`Inspector raw-record pool contains a mismatched event: ${inspectorPath}`);
      }
    }
  }
  assertEqualOrdered(
    chunkTurnIds,
    navigator.items.map(({ turnId }) => turnId),
    `Turn chunks do not match the navigator: ${id}`,
  );
  assertEqualOrdered(
    Object.entries(navigator.turnChunks)
      .map(([turnId, chunk]) => `${turnId}:${chunk}`)
      .toSorted(),
    Object.entries(expectedTurnChunks)
      .map(([turnId, chunk]) => `${turnId}:${chunk}`)
      .toSorted(),
    `Navigator turn chunk index does not match turn payloads: ${id}`,
  );
  assertEqualOrdered(
    Object.entries(navigator.inspectorChunks)
      .map(([target, chunk]) => `${target}:${chunk}`)
      .toSorted(),
    Object.entries(expectedInspectorChunks)
      .map(([target, chunk]) => `${target}:${chunk}`)
      .toSorted(),
    `Inspector chunk index does not match inspector payloads: ${id}`,
  );
  requireFile(tree, `downloads/${indexedSummary.scope}/${id}.md`);
  requireFile(tree, `session/${id}/index.html`);
  await verifySavedHistory(publicRoot, tree, id);
  return navigator.items.length;
}

async function verifySavedHistory(
  publicRoot: string,
  tree: VerifiedTree,
  id: string,
): Promise<void> {
  const base = `payloads/sessions/${id}`;
  if (!tree.files.has(`${base}/history-index.json`)) {
    return;
  }
  const manifest = await parseJson(
    publicRoot,
    `${base}/history-index.json`,
    staticHistoryManifestSchema,
  );
  if (manifest.threadId !== id) {
    throw new Error(`Saved history belongs to another session: ${id}`);
  }
  assertUnique(
    manifest.turns.map((turn) => turn.turnId),
    `saved history turns for ${id}`,
  );
  // oxlint-disable no-await-in-loop -- Validate one bounded saved history chunk at a time
  for (const [turnIndex, turn] of manifest.turns.entries()) {
    const items: string[] = [];
    for (let chunk = 0; chunk < turn.chunks; chunk += 1) {
      const path = `${base}/history-${turnIndex}-${chunk}.json`;
      requireFile(tree, path);
      const saved = await parseJson(publicRoot, path, staticHistoryChunkSchema);
      if (
        saved.threadId !== id ||
        saved.window.turnId !== turn.turnId ||
        saved.window.physicalRolloutId !== turn.physicalRolloutId ||
        saved.window.historyEpoch !== manifest.historyEpoch ||
        saved.window.contentRevision !== manifest.contentRevision
      ) {
        throw new Error(`Saved history chunk identity does not match its manifest: ${path}`);
      }
      for (const item of saved.window.items) {
        items.push(item.itemId);
        if (turn.itemChunks[item.itemId] !== chunk) {
          throw new Error(`Saved history item index does not match its chunk: ${path}`);
        }
      }
      const ids = new Set([
        ...saved.window.items.map((item) => item.itemId),
        saved.window.opening.itemId,
      ]);
      for (const presentation of saved.presentations) {
        if (
          presentation.threadId !== id ||
          presentation.turnId !== turn.turnId ||
          presentation.physicalRolloutId !== turn.physicalRolloutId ||
          presentation.historyEpoch !== manifest.historyEpoch ||
          presentation.contentRevision !== manifest.contentRevision ||
          !ids.has(presentation.itemId)
        ) {
          throw new Error(`Saved rich content identity does not match its history window: ${path}`);
        }
      }
    }
    assertUnique(items, `saved history item IDs for ${id}/${turn.turnId}`);
    if (items.length !== turn.itemCount) {
      throw new Error(`Saved history item count does not match its manifest: ${id}/${turn.turnId}`);
    }
  }
  // oxlint-enable no-await-in-loop
}

function localManifestPath(url: string, directory: "assets" | "favicons" | "previews"): string {
  if (!url.startsWith(`/${directory}/`) || url.includes("?") || url.includes("#")) {
    throw new Error(`Generated ${directory} manifest contains a non-local URL: ${url}`);
  }
  const path = url.slice(1);
  const segments = path.split("/");
  if (segments.length !== 2) {
    throw new Error(`Generated ${directory} manifest contains an invalid URL: ${url}`);
  }
  for (const segment of segments) {
    assertSafeOutputComponent(segment);
  }
  return path;
}

async function assertContentIntegrity(
  publicRoot: string,
  tree: VerifiedTree,
  path: string,
  sha256: string,
  byteSize: number | null,
): Promise<void> {
  requireFile(tree, path);
  const bytes = await readFile(join(publicRoot, ...path.split("/")));
  if (byteSize !== null && bytes.byteLength !== byteSize) {
    throw new Error(`Generated content has an unexpected byte size: ${path}`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256.toLowerCase()) {
    throw new Error(`Generated content failed its SHA-256 integrity check: ${path}`);
  }
}

function isExternalAutomaticResource(value: string): boolean {
  return /^(?:https?:)?\/\//iu.test(value.trim());
}

function htmlResourceValues(html: string): string[] {
  const values: string[] = [];
  const tags = html.matchAll(
    /<(script|img|audio|video|source|track|iframe|embed|input|object|link)\b([^>]*)>/giu,
  );
  for (const match of tags) {
    const tag = match[1]?.toLowerCase();
    const attributes = match[2] ?? "";
    const names =
      tag === "object" ? ["data"] : tag === "link" ? ["href"] : ["src", "srcset", "poster"];
    for (const name of names) {
      const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "giu");
      for (const attribute of attributes.matchAll(pattern)) {
        const value = attribute[1] ?? attribute[2] ?? attribute[3] ?? "";
        values.push(
          ...(name === "srcset"
            ? value.split(",").map((part) => part.trim().split(/\s+/u)[0] ?? "")
            : [value]),
        );
      }
    }
  }
  return values;
}

function cssResourceValues(css: string): string[] {
  const values: string[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/giu)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const match of css.matchAll(/@import\s+(?:url\([^)]*\)|"([^"]*)"|'([^']*)')/giu)) {
    values.push(match[1] ?? match[2] ?? "");
  }
  return values;
}

async function verifyAutomaticResources(publicRoot: string, tree: VerifiedTree): Promise<void> {
  for (const path of tree.htmlFiles) {
    // oxlint-disable-next-line no-await-in-loop -- Files are scanned serially to bound memory for a large prerendered archive.
    const html = await readFile(join(publicRoot, ...path.split("/")), "utf8");
    if (
      htmlResourceValues(html).some(isExternalAutomaticResource) ||
      cssResourceValues(html).some(isExternalAutomaticResource)
    ) {
      throw new Error(`Generated HTML references an external automatic resource: ${path}`);
    }
  }
  for (const path of tree.cssFiles) {
    // oxlint-disable-next-line no-await-in-loop -- Files are scanned serially to bound memory for a large generated bundle.
    const css = await readFile(join(publicRoot, ...path.split("/")), "utf8");
    if (cssResourceValues(css).some(isExternalAutomaticResource)) {
      throw new Error(`Generated CSS references an external automatic resource: ${path}`);
    }
  }
}

export async function verifyGeneratedOutput(
  outputRoot: string,
): Promise<OutputVerificationSummary> {
  const publicRoot = resolve(outputRoot);
  const tree = await inspectOutputTree(publicRoot);
  requireFile(tree, "index.html");
  const exportManifest = await parseJson(publicRoot, "payloads/export.json", exportManifestSchema);
  const sessionIndex = await parseJson(
    publicRoot,
    "payloads/sessions/index.json",
    sessionIndexSchema,
  );
  const library = await parseJson(publicRoot, "payloads/projects.json", staticLibraryPayloadSchema);
  const assetManifest = await parseJson(publicRoot, "payloads/assets.json", assetManifestSchema);
  const faviconManifest = await parseJson(
    publicRoot,
    "payloads/favicons.json",
    faviconManifestSchema,
  );
  assertUnique(
    sessionIndex.sessions.map(({ id }) => id),
    "session IDs in the session index",
  );
  assertLibraryTopology(sessionIndex.sessions, library);
  let turnCount = 0;
  for (const session of sessionIndex.sessions) {
    // oxlint-disable-next-line no-await-in-loop -- Each session is fully checked and released before the next one.
    turnCount += await verifySession(publicRoot, tree, session);
  }
  for (const asset of assetManifest.assets) {
    if (asset.status !== "available") {
      if (asset.url !== null) {
        throw new Error(`Unavailable generated asset has a published URL: ${asset.id}`);
      }
      continue;
    }
    if (asset.url === null || asset.sha256 === null) {
      throw new Error(`Available generated asset is missing integrity metadata: ${asset.id}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- Content hashes are verified without retaining every asset in memory.
    await assertContentIntegrity(
      publicRoot,
      tree,
      localManifestPath(asset.url, "assets"),
      asset.sha256,
      asset.byteSize,
    );
  }
  for (const favicon of faviconManifest.favicons) {
    // oxlint-disable-next-line no-await-in-loop -- Content hashes are verified without retaining every favicon in memory.
    await assertContentIntegrity(
      publicRoot,
      tree,
      localManifestPath(favicon.url, "favicons"),
      favicon.sha256,
      favicon.byteSize,
    );
  }
  if (tree.files.has("payloads/link-previews.json")) {
    const previews = await parseJson(
      publicRoot,
      "payloads/link-previews.json",
      z.strictObject({ version: z.literal(1), previews: z.array(linkPreviewSchema) }),
    );
    assertUnique(
      previews.previews.map((preview) => preview.url),
      "saved preview URLs",
    );
    for (const preview of previews.previews) {
      if (preview.image) {
        // oxlint-disable-next-line no-await-in-loop -- Verify one saved local image at a time
        await assertContentIntegrity(
          publicRoot,
          tree,
          localManifestPath(preview.image.url, "previews"),
          preview.image.sha256,
          preview.image.byteSize,
        );
      }
    }
  }
  if (exportManifest.pagefind) {
    requireFile(tree, "pagefind/pagefind.js");
    if (
      ![...tree.files].some(
        (path) =>
          (path.startsWith("pagefind/") && path.endsWith(".wasm")) ||
          /^pagefind\/wasm\.[^/]+\.pagefind$/u.test(path),
      )
    ) {
      throw new Error("Generated output is missing the Pagefind WebAssembly runtime.");
    }
  }
  await verifyAutomaticResources(publicRoot, tree);
  return {
    publicRoot,
    sessionCount: sessionIndex.sessions.length,
    turnCount,
    assetCount: assetManifest.assets.length,
    faviconCount: faviconManifest.favicons.length,
    searchIndex: exportManifest.pagefind,
    checkedFiles: tree.files.size,
  };
}
