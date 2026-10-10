/**
 * 限额降级（provider 额度耗尽时自动切模型）的纯逻辑。
 *
 * 背景：OpenCode 自身没有模型降级 —— OpenAPI 里 fallback/failover 字样为 0，
 * Models 文档只有「配置的模型不可用时兜底到最新可用模型」，与限额无关。
 * 所以这件事只能做在桥层：检测到限额 → session.switchModel → 重发。
 *
 * 这里只放可单测的判定与挑选逻辑，副作用（切模型/重发/通知）留在 app.ts。
 */

/** 失败类型：目前只有「限额」值得切模型，其余错误切了也没用 */
export type ProviderFailureKind = "rate_limit"

/**
 * 把 provider 失败原文归类。
 *
 * 真实样例（2026-10-08 / 10-10 各一次，桥侧原文）：
 *   AI.Error: Provider request failed with HTTP 429:
 *   {"code":6004,"msg":"您的使用量已超出频率限制，将在 … 重置，您也可以切换其他模型继续使用。"}
 *
 * 判定故意收紧：只认明确的限额特征，避免把普通报错（可能含随机数字）误判成限额，
 * 那会导致无谓的切模型。
 */
export function classifyProviderFailure(text: string | undefined | null): ProviderFailureKind | null {
  if (!text) return null
  const t = text.toLowerCase()
  if (/http\s*429/.test(t)) return "rate_limit"
  if (/\b6004\b/.test(t)) return "rate_limit"
  if (/rate.?limit|too many requests/.test(t)) return "rate_limit"
  if (t.includes("频率限制") || t.includes("使用量已超出")) return "rate_limit"
  return null
}

/**
 * 从候选里挑下一个模型：跳过空项、跳过与当前相同的项。
 * 返回 null 表示没有可用候选（保持原模型，不做无谓切换）。
 */
export function pickFallback(current: string | undefined | null, fallbacks: readonly string[]): string | null {
  for (const f of fallbacks) {
    const name = String(f ?? "").trim()
    if (!name) continue
    if (current && name === String(current).trim()) continue
    return name
  }
  return null
}

/** 模型引用必须是 `providerID/modelID` 形式 */
export function parseModelRef(ref: string): { providerID: string; id: string } | null {
  const s = String(ref ?? "").trim()
  const i = s.indexOf("/")
  if (i <= 0 || i === s.length - 1) return null
  return { providerID: s.slice(0, i), id: s.slice(i + 1) }
}
