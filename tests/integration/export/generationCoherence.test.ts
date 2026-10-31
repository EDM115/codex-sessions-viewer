import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runStaticExport } from "#server/export/exportPipeline.ts";
import { prepareConversationForExport } from "#server/export/prepareConversation.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

import {
  ancestryThread,
  mixedAncestryFixture,
  jsonl,
} from "../../fixtures/history/mixedAncestry.ts";

it.each(["leaf", "ancestor"])(
  "never publishes independently valid source generations after %s replacement during rich preparation",
  async (changed) => {
    const root = await mkdtemp(join(tmpdir(), "coherence-"));
    const home = join(root, "home");
    const fixture = await mixedAncestryFixture(home, { compressed: true });
    const outputRoot = join(root, "output");
    const paths = {
      cacheDir: join(root, "cache"),
      cacheDatabase: join(root, "cache/viewer.sqlite"),
      configDir: join(root, "config"),
      configFile: join(root, "config/config.json"),
      generatedDir: join(root, "generated"),
    };
    let preparedA = false;
    let searchText = "";
    try {
      const exported = await runStaticExport({
        codexHome: home,
        paths,
        outputRoot,
        generatedRoot: paths.generatedDir,
        offline: true,
        index: true,
        async prepareConversation(database, conversation, options) {
          expect(JSON.stringify(conversation.turns)).toContain("ANCESTOR_A");
          expect(JSON.stringify(conversation.turns)).toContain("LEAF_ANSWER");
          preparedA = true;
          if (changed === "leaf") {
            await writeFile(
              fixture.leafPath,
              jsonl(fixture.leafRecords).replaceAll("LEAF_ANSWER", "REPLACED_B"),
            );
          } else {
            await fixture.writeBase("ANCESTOR_B");
          }
          return prepareConversationForExport(database, conversation, options);
        },
        async generate({ outputRoot: destination }) {
          await mkdir(destination, { recursive: true });
          await writeFile(
            join(destination, "index.html"),
            "<!doctype html><title>Coherence</title>",
          );
        },
        async buildSearch(records, outputPath) {
          searchText = JSON.stringify(records);
          return { recordCount: records.length, outputPath };
        },
      });
      expect(preparedA).toBe(true);
      expect(exported).toMatchObject({ sessionCount: 0, failed: 1, pagefindRecords: 0 });
      expect(searchText).toBe("[]");
      const repository = new StaticConversationRepository(
        async (path) => JSON.parse(await readFile(join(outputRoot, path), "utf8")) as unknown,
      );
      expect((await repository.listSessions({ scope: "active" })).items).toEqual([]);
      await expect(
        stat(join(outputRoot, `downloads/active/${ancestryThread}.md`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(join(outputRoot, `payloads/sessions/${ancestryThread}/history-index.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(join(outputRoot, `payloads/sessions/${ancestryThread}/summary.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
