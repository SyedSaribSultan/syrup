import type { MetadataRoute } from "next"

/**
 * Shared chats (/c/…) must never be indexed. They are deliberately NOT disallowed here: a crawler that may not
 * fetch a page never sees its noindex and can still list the bare URL. Every /c response carries
 * X-Robots-Tag: noindex (next.config.ts) and the page a robots noindex meta, so crawlers read it and drop the URL.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
  }
}
