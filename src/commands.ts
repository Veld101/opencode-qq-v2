export type QqCommand =
  | { type: "new" }
  | { type: "status" }
  | { type: "help" }
  | { type: "workspace"; arg?: string }

export function parseCommand(text: string): QqCommand | null {
  const t = text.trim()

  // /workspace [name|index] 与简写 /ws
  const ws = /^\/(?:workspace|ws)(?:\s+(.+))?$/i.exec(t)
  if (ws) {
    const arg = ws[1]?.trim()
    return { type: "workspace", arg: arg && arg.length > 0 ? arg : undefined }
  }

  const m = /^\/(new|status|help)\s*$/i.exec(t)
  if (!m) return null
  return { type: m[1].toLowerCase() as "new" | "status" | "help" }
}
