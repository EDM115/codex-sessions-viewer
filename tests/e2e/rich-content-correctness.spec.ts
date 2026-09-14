import { expect, test } from "@nuxt/test-utils/playwright";

import { parseRichText } from "../../server/content/parseRichText.ts";
import type {
  ConversationMessage,
  ConversationSummary,
  ConversationTurn,
} from "../../shared/types/conversation.ts";

const sessionId = "88888888-8888-4888-8888-888888888888";
const timestamp = "2026-09-14T12:00:00.000Z";
const patch = (replacement: string) =>
  `diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -1 +1 @@\n-old first\n+new first\ndiff --git a/second.txt b/second.txt\n--- a/second.txt\n+++ b/second.txt\n@@ -1 +1 @@\n-old second\n+${replacement}\n`;
const markdown = (replacement: string) =>
  [
    "[reader](<C:/work/my%20file.ts:12:4>) [docs](https://fixture.example/docs)",
    "Note[^1] again[^1].\n\n[^1]: Local body.",
    "```ts\nconst answer: number = 42\n```",
    '```python\nprint("hello")\n```',
    '<pre><code class="language-python">print("raw html")</code></pre>',
    "```made-up-language\nplain <source>\n```",
    `\`\`\`diff\n${patch(replacement)}\`\`\``,
    "```mermaid\ngraph TD\n  Source --> Preview\n```",
  ].join("\n\n");
const summary: ConversationSummary = {
  id: sessionId,
  title: "Rich content correctness",
  scope: "active",
  sourcePath: "fixture.jsonl",
  createdAt: timestamp,
  updatedAt: timestamp,
  cwd: null,
  gitBranch: null,
  gitSha: null,
  gitOriginUrl: null,
  models: [],
  reasoningEfforts: [],
  turnCount: 1,
  assistantMessageCount: 2,
  toolCallCount: 0,
  toolCounts: {},
  preview: "Rich content",
  pinned: false,
  sectionName: null,
  parentThreadId: null,
  childThreadIds: [],
  hasMedia: false,
  diagnosticCount: 0,
  revision: "fixture-1",
};
async function message(id: string, sourceMarkdown: string): Promise<ConversationMessage> {
  return {
    id,
    turnId: "rich-turn",
    role: "assistant",
    phase: "final",
    createdAt: timestamp,
    sourceMarkdown,
    body: (await parseRichText(sourceMarkdown)).document,
    attachmentIds: [],
    rawEventIds: [],
  };
}

// This exercises the production components and installed renderer libraries while
// fixture API responses keep the run independent of user data and the internet.
test("renders complete reactive diffs, scoped footnotes, real token colors and local favicon recovery", async ({
  page,
  goto,
}) => {
  let body = markdown("new second");
  let revision = "fixture-1";
  let faviconReady = false;
  let turnRequests = 0;
  const requests: string[] = [];
  page.on("request", (request) => {
    if (!new URL(request.url()).hostname.match(/^(?:127\.0\.0\.1|localhost)$/u)) {
      requests.push(request.url());
    }
  });
  await page.addInitScript(() => {
    class LocalEvents extends EventTarget {
      forward = (event: Event) => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        const detail: unknown = event.detail;
        if (
          typeof detail !== "object" ||
          detail === null ||
          !("type" in detail) ||
          typeof detail.type !== "string"
        ) {
          return;
        }
        this.dispatchEvent(new MessageEvent(detail.type, { data: JSON.stringify(detail) }));
      };
      constructor() {
        super();
        window.addEventListener("rich-fixture-invalidate", this.forward);
      }
      close() {
        window.removeEventListener("rich-fixture-invalidate", this.forward);
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: LocalEvents });
  });
  await page.route("**/api/favicons/**", (route) =>
    faviconReady
      ? route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          ),
        })
      : route.fulfill({ status: 404, body: "Not cached" }),
  );
  await page.route(`**/api/sessions/${sessionId}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/navigator")) {
      return route.fulfill({
        json: [
          {
            turnId: "rich-turn",
            index: 0,
            userMessageId: null,
            promptPreview: "Rich fixture",
            assistantPreview: "Rich fixture",
            proseLengthBucket: 4,
            createdAt: timestamp,
          },
        ],
      });
    }
    if (pathname.endsWith("/turns")) {
      ++turnRequests;
      const turn: ConversationTurn = {
        id: "rich-turn",
        sourceTurnId: null,
        sessionId,
        index: 0,
        userMessage: {
          ...(await message("rich-second", "Another[^1].\n\n[^1]: Other body.")),
          role: "user",
        },
        assistantMessages: [await message("rich-first", body)],
        activities: [],
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
        timeToFirstTokenMs: null,
        tokenDelta: null,
        models: [],
        reasoningEfforts: [],
        toolCounts: {},
        diagnosticIds: [],
      };
      return route.fulfill({
        json: { sessionId, turns: [turn], previousCursor: null, nextCursor: null, revision },
      });
    }
    return route.fulfill({ json: { ...summary, revision } });
  });
  await goto(`/session/${sessionId}?turn=rich-turn`, { waitUntil: "hydration" });
  const richDocument = page.locator(".conversation-message--assistant .rich-text-document").first();
  await expect(richDocument.locator(".rich-file-reference__path")).toHaveText(
    "C:\\work\\my file.ts",
  );
  await expect(page.locator('.rich-text-document sup a[href^="#"]')).toHaveCount(3);
  await expect(page.locator('.rich-text-document section a[href^="#"]')).toHaveCount(3);
  await Promise.all(
    (await page.locator(".rich-text-document").all()).map(async (rendered) => {
      const targets = await rendered.locator('a[href^="#"]').evaluateAll((links) =>
        links.map((link) => {
          const target = document.getElementById(link.getAttribute("href")!.slice(1));
          return (
            target !== null &&
            target.closest(".rich-text-document") === link.closest(".rich-text-document")
          );
        }),
      );
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.every(Boolean)).toBe(true);
    }),
  );
  const codes = richDocument.locator(".rich-code-block");
  await Promise.all(
    [0, 1, 2].map(async (index) => {
      const colors = await codes
        .nth(index)
        .locator("code span[style]")
        .evaluateAll((tokens) => [
          ...new Set(tokens.map((token) => getComputedStyle(token).color)),
        ]);
      expect(colors.length).toBeGreaterThan(1);
    }),
  );
  await expect(codes.nth(3).locator("code")).toHaveText("plain <source>");
  const darkColor = await codes
    .first()
    .locator("code span[style]")
    .first()
    .evaluate((token) => getComputedStyle(token).color);
  await page.getByRole("link", { name: "Open Settings" }).click();
  await page.locator('[data-theme-choice="quiet-precision"]').click();
  await page.goBack();
  await expect
    .poll(() =>
      codes
        .first()
        .locator("code span[style]")
        .first()
        .evaluate((token) => getComputedStyle(token).color),
    )
    .not.toBe(darkColor);
  const diff = richDocument.locator(".rich-diff");
  await expect(diff).toHaveAttribute("data-state", "ready");
  await expect(diff.locator("[data-diff-file]")).toHaveCount(2);
  await expect(diff.locator("[data-diff-file]").nth(0)).toContainText("new first");
  await expect(diff.locator("[data-diff-file]").nth(1)).toContainText("new second");
  const anchor = richDocument.locator('a[href="https://fixture.example/docs"]');
  await expect(anchor.locator("img")).toHaveCount(0);
  const before = turnRequests;
  faviconReady = true;
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("rich-fixture-invalidate", {
        detail: {
          type: "favicon.updated",
          ids: ["https://fixture.example"],
          revision: "favicon-ready",
        },
      }),
    ),
  );
  await expect(anchor.locator("img")).toBeVisible();
  expect(turnRequests).toBe(before);
  body = markdown("latest second");
  revision = "fixture-2";
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new CustomEvent("rich-fixture-invalidate", {
          detail: { type: "session.updated", ids: [id], revision: "fixture-2" },
        }),
      ),
    sessionId,
  );
  await expect(diff.locator("[data-diff-file]").nth(1)).toContainText("latest second");
  const mermaid = richDocument.locator(".rich-mermaid");
  await mermaid.getByRole("tab", { name: "Preview Mermaid diagram" }).click();
  await expect(mermaid.locator("[data-mermaid-preview] svg")).toBeVisible();
  await expect(mermaid.locator("[data-mermaid-preview] svg")).toContainText("Preview");
  expect(requests).toEqual([]);
});
