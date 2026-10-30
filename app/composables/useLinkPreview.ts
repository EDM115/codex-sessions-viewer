import type { InjectionKey } from "vue";

import type { LinkPreviewResolver } from "#shared/types/linkPreview.ts";

export const linkPreviewResolverKey: InjectionKey<LinkPreviewResolver | undefined> =
  Symbol("viewer-link-preview");
export function provideLinkPreviewResolver(resolver: LinkPreviewResolver | undefined) {
  provide(linkPreviewResolverKey, resolver);
}
export function useLinkPreviewResolver() {
  return inject(linkPreviewResolverKey, undefined);
}
