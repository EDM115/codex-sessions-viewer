import { describe, expect, it } from "vitest";

import { parseSessionMetaBytes } from "../../../server/ingestion/sessionMetaPrefix.ts";
import {
  classifyCatalogThread,
  classifyNormalizedSession,
  cachedThreadClassification,
  isThreadVisible,
  type CatalogThreadMetadata,
} from "../../../server/metadata/threadClassification.ts";
import type { JsonObject } from "../../../shared/types/conversation.ts";
import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

async function rawSession(payload: JsonObject) {
  const session = await normalizedRolloutFixture({
    name: "modern.jsonl",
    sourcePath: "C:/current.jsonl",
    scope: "active",
    revision: "classification-review",
  });
  session.summary.id = "chat";
  session.summary.parentThreadId = null;
  session.rawEvents = [
    {
      id: "meta",
      type: "session_meta",
      turnId: null,
      timestamp: null,
      payload: { type: "session_meta", payload: { id: "chat", ...payload } },
    },
  ];
  return session;
}

describe("structural visibility policy", () => {
  it.each([
    {
      subAgent: {
        thread_spawn: { parent_thread_id: "parent", agent_role: "reviewer", agentNickname: "Ada" },
      },
    },
    {
      subagent: {
        threadSpawn: { parentThreadId: "parent", agentRole: "reviewer", agent_nickname: "Ada" },
      },
    },
  ] as JsonObject[])(
    "preserves mixed native role shapes with explicit metadata precedence: %j",
    (source) => {
      expect(classifyCatalogThread({ source })).toMatchObject({
        visibility: "delegated-child",
        agentRole: "reviewer",
        agentNickname: "Ada",
      });
      expect(
        classifyCatalogThread({ source, agentRole: "builder", agentNickname: "Grace" }),
      ).toMatchObject({ agentRole: "builder", agentNickname: "Grace" });
    },
  );
  it.each([
    ["attached", "raw"],
    ["attached", "native"],
    ["fork", "raw"],
    ["fork", "native"],
  ] as const)(
    "reconciles %s ownership from %s before inferring delegation from repeated flat parents",
    async (relationship, origin) => {
      const rawOwnership: JsonObject =
        relationship === "attached"
          ? { attached_parent_thread_id: "owner" }
          : { forked_from_id: "owner" };
      const nativeOwnership =
        relationship === "attached"
          ? { attachedParentThreadId: "owner" }
          : { forkedFromId: "owner" };
      const payload: JsonObject = {
        thread_source: "user",
        parent_thread_id: "owner",
        ...(origin === "raw" ? rawOwnership : {}),
      };
      const native: CatalogThreadMetadata = {
        source: "cli",
        parentThreadId: "owner",
        ...(origin === "native" ? nativeOwnership : {}),
      };
      const session = await rawSession(payload);
      const owned = classifyNormalizedSession(session, native);
      expect(owned).toMatchObject({
        visibility: "user-root",
        relationship,
        parentThreadId: "owner",
      });
      expect(owned.declarations?.every((declaration) => !declaration.spawn)).toBe(true);
      expect(
        classifyNormalizedSession(session, {
          ...native,
          source: { subAgent: { thread_spawn: { parent_thread_id: "owner" } } },
        }),
      ).toMatchObject({ visibility: "delegated-child", relationship: "spawn" });
      expect(
        classifyNormalizedSession(
          await rawSession({
            ...payload,
            source: { subagent: { thread_spawn: { parent_thread_id: "owner" } } },
          }),
          native,
        ),
      ).toMatchObject({ visibility: "delegated-child", relationship: "spawn" });
      expect(
        classifyNormalizedSession(session, native, { spawnParentThreadId: "owner" }),
      ).toMatchObject({ visibility: "delegated-child", relationship: "spawn" });
    },
  );
  it("retains native structured helper evidence behind raw transport and preserves conflicting parent origins", async () => {
    const transport = await rawSession({ source: "cli" });
    expect(
      classifyNormalizedSession(transport, {
        source: { subAgent: { other: "guardian", parentThreadId: "owner" } },
      }),
    ).toMatchObject({ visibility: "internal", transportSource: "cli", parentThreadId: "owner" });
    const spawned = await rawSession({
      source: { subagent: { thread_spawn: { parent_thread_id: "raw-parent" } } },
    });
    const conflict = classifyNormalizedSession(
      spawned,
      { parentThreadId: "native-parent" },
      { spawnParentThreadId: "edge-parent" },
    );
    expect(conflict).toMatchObject({
      visibility: "unresolved",
      reasons: expect.arrayContaining(["conflicting-parent-evidence"]),
    });
    expect(conflict.declarations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: "raw", parentThreadIds: ["raw-parent"] }),
        expect.objectContaining({ origin: "native", parentThreadIds: ["native-parent"] }),
        expect.objectContaining({ origin: "spawn-edge", parentThreadIds: ["edge-parent"] }),
      ]),
    );
  });
  it("never promotes an unsupported role through flat, source or native-edge spawn evidence", () => {
    expect(
      classifyCatalogThread({ threadSource: "custom-role", parentThreadId: "parent" }).visibility,
    ).toBe("unresolved");
    expect(
      classifyCatalogThread({
        threadSource: "custom-role",
        source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
      }).visibility,
    ).toBe("unresolved");
    expect(
      classifyCatalogThread({ threadSource: "custom-role" }, { spawnParentThreadId: "parent" })
        .visibility,
    ).toBe("unresolved");
  });
  it.each<[string, JsonObject]>([
    ["role", { source: "cli", thread_source: 12 }],
    ["ephemeral", { source: "cli", ephemeral: "true" }],
    ["source", { source: 12 }],
  ])("agrees across raw prefix and normalized adapters on malformed %s", async (_name, payload) => {
    const prefix = parseSessionMetaBytes(
      "C:/current.jsonl",
      Buffer.from(
        `${JSON.stringify({ type: "session_meta", payload: { id: "chat", ...payload } })}\n`,
      ),
    );
    expect(prefix.meta).toBeNull();
    expect(prefix.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "source.invalid_jsonl" })]),
    );
    expect(classifyNormalizedSession(await rawSession(payload))).toMatchObject({
      visibility: "unresolved",
      reasons: expect.arrayContaining(["invalid-structural-metadata"]),
    });
  });
  it("rejects unsupported/current-invalid persisted envelopes instead of applying legacy fallback", () => {
    const user = classifyCatalogThread({ threadSource: "user" });
    const envelope = {
      version: 2,
      origin: "rollout-prefix",
      status: "missing",
      parentThreadIdHint: null,
      meta: null,
    };
    for (const invalid of [
      { ...envelope, version: 999, classification: user },
      { ...envelope, status: "invalid" },
      envelope,
      { classification: user },
    ]) {
      expect(cachedThreadClassification(invalid, "root").visibility).toBe("unresolved");
    }
    expect(cachedThreadClassification({ ...envelope, version: 1 }, "root").visibility).toBe(
      "user-root",
    );
    expect(cachedThreadClassification(null, "root").visibility).toBe("user-root");
  });
  it("distinguishes incomplete spawns from declared orphan parents and allows independent evidence to complete them", () => {
    const source = { subagent: { thread_spawn: {} } };
    expect(classifyCatalogThread({ source })).toMatchObject({
      visibility: "unresolved",
      reasons: expect.arrayContaining(["missing-spawn-parent"]),
    });
    expect(classifyCatalogThread({ source }, { spawnParentThreadId: "missing" })).toMatchObject({
      visibility: "delegated-child",
      parentThreadId: "missing",
    });
  });
  it("keeps transport separate and exposes unsupported roles through diagnostics", () => {
    expect(
      classifyCatalogThread({ source: "custom-transport", threadSource: "user" }),
    ).toMatchObject({ visibility: "user-root", transportSource: "custom-transport" });
    const unknown = classifyCatalogThread({ threadSource: "custom-role" });
    expect(unknown).toMatchObject({
      visibility: "unresolved",
      reasons: ["unknown-structural-source"],
    });
    expect(isThreadVisible(unknown)).toBe(false);
    expect(isThreadVisible(unknown, "diagnostic")).toBe(true);
    expect(classifyCatalogThread({})).toMatchObject({
      visibility: "user-root",
      reasons: ["legacy-absent-role-compatible-root"],
    });
  });
  it("preserves conflicts, attachment and fork relationships without inventing spawn edges", () => {
    expect(
      classifyCatalogThread({ threadSource: "user", source: { subagent: { other: "guardian" } } })
        .visibility,
    ).toBe("unresolved");
    expect(
      classifyCatalogThread({
        threadSource: "user",
        parentThreadId: "owner",
        attachedParentThreadId: "owner",
      }),
    ).toMatchObject({ visibility: "user-root", relationship: "attached", parentThreadId: "owner" });
    expect(
      classifyCatalogThread({
        threadSource: "user",
        parentThreadId: "ancestor",
        forkedFromId: "ancestor",
      }),
    ).toMatchObject({ visibility: "user-root", relationship: "fork" });
    expect(
      classifyCatalogThread({ threadSource: "user" }, { conflictingThreadSource: "security_scan" })
        .visibility,
    ).toBe("unresolved");
    expect(
      classifyCatalogThread({
        source: { subagent: { thread_spawn: { parent_thread_id: "spawn-parent" } } },
        attachedParentThreadId: "owner",
        forkedFromId: "history",
        historyMode: "inherited",
      }),
    ).toMatchObject({
      visibility: "delegated-child",
      relationship: "spawn",
      parentThreadId: "spawn-parent",
      attachedParentThreadId: "owner",
      historyMode: "inherited",
    });
  });
});
