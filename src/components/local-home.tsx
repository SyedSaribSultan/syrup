"use client"

import { NewChat } from "@/components/new-chat"

export function LocalHome() {
  return <NewChat hrefFor={(id) => `/s/${id}`} />
}
