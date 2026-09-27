export type PermissionReply = "once" | "always" | "reject"

type Pending = {
  permissionId: string
  sessionId: string
  summary: string
  timer: ReturnType<typeof setTimeout>
}

/**
 * QQ 侧远程审批：把 OpenCode 的权限请求编号推给用户，
 * 用户回复「同意 N / 拒绝 N / 总是 N」后代为应答。
 */
export class Approver {
  private pending = new Map<number, Pending>()
  private nextSeq = 1

  constructor(private timeoutMs: number) {}

  register(sessionId: string, permissionId: string, summary: string): number {
    const seq = this.nextSeq++
    const timer = setTimeout(() => this.pending.delete(seq), this.timeoutMs)
    this.pending.set(seq, { permissionId, sessionId, summary, timer })
    return seq
  }

  render(seq: number): string {
    const item = this.pending.get(seq)
    return [
      `[权限请求 #${seq}] ${item?.summary ?? ""}`,
      `回复“同意 ${seq}”批准本次，“总是 ${seq}”一直批准，“拒绝 ${seq}”拒绝。`,
    ].join("\n")
  }

  parseReply(text: string): { reply: PermissionReply; seq: number } | null {
    const m = /^(同意|拒绝|总是)\s*(\d+)$/.exec(text.trim())
    if (!m) return null
    const reply: PermissionReply = m[1] === "同意" ? "once" : m[1] === "总是" ? "always" : "reject"
    return { reply, seq: Number(m[2]) }
  }

  confirm(seq: number): Omit<Pending, "timer"> | undefined {
    const item = this.pending.get(seq)
    if (!item) return undefined
    clearTimeout(item.timer)
    this.pending.delete(seq)
    const { timer: _t, ...rest } = item
    return rest
  }

  clearSession(sessionId: string): void {
    for (const [seq, item] of this.pending) {
      if (item.sessionId === sessionId) {
        clearTimeout(item.timer)
        this.pending.delete(seq)
      }
    }
  }

  countBySession(sessionId: string): number {
    let n = 0
    for (const item of this.pending.values()) if (item.sessionId === sessionId) n++
    return n
  }
}
