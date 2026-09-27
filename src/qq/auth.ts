import { TOKEN_URL } from "../constants"

type TokenResponse = {
  access_token?: string
  expires_in?: string | number
  code?: number
  message?: string
}

/**
 * access_token 管理。
 *
 * 官方注意点：该接口失败时 HTTP 仍返回 200，错误在响应体的 `code` 里，
 * 因此必须按 code 判定，不能只看 res.ok。
 */
export class AuthManager {
  private token: string | null = null
  private expireAt = 0

  constructor(
    private appId: string,
    private appSecret: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now()
    if (this.token && now < this.expireAt - 60_000) return this.token

    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    })
    if (!res.ok) throw new Error(`getAppAccessToken failed: HTTP ${res.status}`)

    const data = (await res.json()) as TokenResponse
    if (!data.access_token) {
      throw new Error(`getAppAccessToken 业务失败: code=${data.code ?? "?"} message=${data.message ?? ""}`)
    }

    this.token = data.access_token
    this.expireAt = Date.now() + Number(data.expires_in ?? 7200) * 1000
    return this.token
  }
}
