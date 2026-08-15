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

export function useMediaViewer() {
  const item = shallowRef<MediaViewerItem | null>(null);
  let opener: HTMLElement | null = null;

  function open(next: MediaViewerItem): void {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    item.value = next;
  }

  function close(): void {
    item.value = null;
    const restore = opener;
    opener = null;
    void nextTick().then(() => {
      if (restore?.isConnected) {
        restore.focus();
      }
      return undefined;
    });
  }

  return { close, item: readonly(item), open };
}
