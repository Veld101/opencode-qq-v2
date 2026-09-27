import type { QqConfig } from "./types"

export type ResolvedWorkspace = {
  name: string
  /** 缺省表示跟随插件所在 location */
  path?: string
  isDefault: boolean
}

type WorkspaceInput = Pick<QqConfig, "workspaces" | "workdir" | "defaultWorkspace">

/**
 * 解析可用工作区列表。
 *
 * - 配置了 `workspaces` 就按它来
 * - 否则把 `workdir` 当成唯一的默认工作区（向后兼容旧配置）
 * - 名字去重、去空；至少保留一项
 */
export function resolveWorkspaces(cfg: WorkspaceInput): ResolvedWorkspace[] {
  const raw = cfg.workspaces && cfg.workspaces.length > 0 ? cfg.workspaces : [{ name: "default", path: cfg.workdir }]

  const seen = new Set<string>()
  const list: ResolvedWorkspace[] = []
  for (const w of raw) {
    const name = String(w?.name ?? "").trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const path = typeof w?.path === "string" && w.path.trim().length > 0 ? w.path.trim() : undefined
    list.push({ name, path, isDefault: false })
  }
  if (list.length === 0) list.push({ name: "default", path: cfg.workdir, isDefault: false })

  const preferred = cfg.defaultWorkspace && list.some((w) => w.name === cfg.defaultWorkspace) ? cfg.defaultWorkspace : list[0].name
  for (const w of list) w.isDefault = w.name === preferred
  return list
}

export function defaultWorkspaceName(list: ResolvedWorkspace[]): string {
  return (list.find((w) => w.isDefault) ?? list[0]).name
}

/** 按名字（大小写不敏感）或 1 基序号查找 */
export function findWorkspace(list: ResolvedWorkspace[], key: string): ResolvedWorkspace | null {
  const k = key.trim().toLowerCase()
  if (!k) return null
  const byName = list.find((w) => w.name.toLowerCase() === k)
  if (byName) return byName
  const n = Number(k)
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1]
  return null
}

/** 列表指纹：用于判断配置里的工作区是否变化（变化则需要重建会话） */
export function workspacesFingerprint(list: ResolvedWorkspace[]): string {
  return list.map((w) => `${w.name}=${w.path ?? ""}`).join("|")
}
