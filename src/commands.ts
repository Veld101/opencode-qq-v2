export type QqCommand = { type: "new" | "status" | "help" }

export function parseCommand(text: string): QqCommand | null {
  const m = /^\/(new|status|help)\s*$/i.exec(text.trim())
  if (!m) return null
  return { type: m[1].toLowerCase() as QqCommand["type"] }
}
