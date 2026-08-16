import { nextTick, readonly, shallowRef } from "vue";

interface MediaViewerItemBase {
  alt: string;
  filename: string;
  height: number | null;
  mimeType: string;
  width: number | null;
}

export interface MediaViewerImageItem extends MediaViewerItemBase {
  kind: "image";
  src: string;
}

export interface MediaViewerSvgItem extends MediaViewerItemBase {
  kind: "svg";
  source: string;
  svg: string;
}

export type MediaViewerItem = MediaViewerImageItem | MediaViewerSvgItem;

interface OpenerFallback {
  ariaLabel: string | null;
  messageId: string | null;
  occurrence: number;
  tagName: string;
}

function matchingOpeners(description: Omit<OpenerFallback, "occurrence">): HTMLElement[] {
  const messageRoot =
    description.messageId === null
      ? null
      : [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (candidate) => candidate.dataset["messageId"] === description.messageId,
        );
  const root: ParentNode = messageRoot ?? document;
  return [...root.querySelectorAll<HTMLElement>(description.tagName)].filter(
    (candidate) => candidate.getAttribute("aria-label") === description.ariaLabel,
  );
}

function describeOpener(element: HTMLElement): OpenerFallback {
  const description = {
    ariaLabel: element.getAttribute("aria-label"),
    messageId: element.closest<HTMLElement>("[data-message-id]")?.dataset["messageId"] ?? null,
    tagName: element.tagName.toLowerCase(),
  };
  return {
    ...description,
    occurrence: Math.max(0, matchingOpeners(description).indexOf(element)),
  };
}

export function useMediaViewer() {
  const item = shallowRef<MediaViewerItem | null>(null);
  let opener: HTMLElement | null = null;
  let openerFallback: OpenerFallback | null = null;

  function open(next: MediaViewerItem): void {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openerFallback = opener === null ? null : describeOpener(opener);
    item.value = next;
  }

  function close(): void {
    item.value = null;
    const restore = opener;
    const fallback = openerFallback;
    opener = null;
    openerFallback = null;
    void nextTick().then(() => {
      requestAnimationFrame(() => {
        const target =
          restore?.isConnected === true
            ? restore
            : fallback === null
              ? null
              : (matchingOpeners(fallback)[fallback.occurrence] ?? null);
        target?.focus();
      });
    });
  }

  return { close, item: readonly(item), open };
}
