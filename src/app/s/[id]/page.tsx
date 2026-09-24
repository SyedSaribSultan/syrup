"use client"

import { useParams } from "next/navigation"
import { SessionView } from "@/components/session-view"

export default function SessionPage() {
  const { id } = useParams<{ id: string }>()
  return <SessionView id={id} />
}
