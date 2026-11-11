/** Minimal GitHub REST client: fetch, JSON, Link-header pagination, token-expiry header. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 300)}`);
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class GitHub {
  /** From the `github-authentication-token-expiration` header, when GitHub sends it. */
  tokenExpiration?: Date;

  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.github.com",
    private readonly fetchImpl: Fetch = (u, i) => fetch(u, i),
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Follow `Link: rel="next"` pages, collecting `pick(page)` items. */
  async paginate<T>(path: string, pick: (page: any) => T[]): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const res = await this.raw("GET", next);
      out.push(...pick(await res.json()));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    }
    return out;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "actions-spend-pacer",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const exp = res.headers.get("github-authentication-token-expiration");
    if (exp && !Number.isNaN(Date.parse(exp))) this.tokenExpiration = new Date(exp);
    if (!res.ok) throw new HttpError(res.status, method, path.replace(this.baseUrl, ""), await res.text());
    return res;
  }
}
