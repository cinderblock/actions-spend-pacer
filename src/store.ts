import type { GitHub } from "./github.ts";
import { STATE_MARKER, StateError, parseState, withState } from "./state.ts";
import type { State } from "./types.ts";
import { emptyState } from "./types.ts";

export interface StateStore {
  load(): Promise<State>;
  /** Persist state, and refresh the human-readable status shown with it. */
  save(state: State, statusMarkdown: string): Promise<void>;
  /** Post an event (pause/resume) where the owner gets notified. */
  notify(markdown: string): Promise<void>;
  describe(): string;
}

interface ApiIssue {
  number: number;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  pull_request?: unknown;
}

/**
 * State lives in one open issue: a status table plus a hidden JSON block. Only issues
 * opened by a trusted author count, so a stranger opening an issue with a fake state block
 * in a public repo can't steer the pacer.
 */
export class IssueStore implements StateStore {
  private issue?: ApiIssue;

  constructor(
    private readonly gh: GitHub,
    private readonly repo: string, // owner/name
    private readonly title: string,
    private readonly trustedAuthors: string[],
  ) {}

  describe() {
    return this.issue ? this.issue.html_url : `a new issue in ${this.repo}`;
  }

  private async find(): Promise<ApiIssue | undefined> {
    const trusted = new Set(this.trustedAuthors.map((a) => a.toLowerCase()));
    const issues = await this.gh.paginate<ApiIssue>(
      `/repos/${this.repo}/issues?state=open&per_page=100`,
      (p) => p,
    );
    const ours = issues.filter(
      (i) => !i.pull_request && i.body?.includes(STATE_MARKER) && trusted.has(i.user?.login.toLowerCase() ?? ""),
    );
    if (ours.length > 1)
      throw new StateError(
        `Found ${ours.length} open state issues in ${this.repo} (#${ours.map((i) => i.number).join(", #")}); close all but one.`,
      );
    return ours[0];
  }

  async load(): Promise<State> {
    this.issue = await this.find();
    return this.issue ? parseState(this.issue.body) : emptyState();
  }

  async save(state: State, statusMarkdown: string): Promise<void> {
    const body = withState(statusMarkdown, state);
    if (this.issue) {
      this.issue = await this.gh.request<ApiIssue>("PATCH", `/repos/${this.repo}/issues/${this.issue.number}`, { body });
    } else {
      this.issue = await this.gh.request<ApiIssue>("POST", `/repos/${this.repo}/issues`, { title: this.title, body });
    }
  }

  async notify(markdown: string): Promise<void> {
    if (!this.issue) throw new Error("notify() before save(): no state issue yet.");
    await this.gh.request("POST", `/repos/${this.repo}/issues/${this.issue.number}/comments`, { body: markdown });
  }
}

/** In-memory store for dry runs and tests. */
export class MemoryStore implements StateStore {
  saved: { state: State; status: string }[] = [];
  notes: string[] = [];
  constructor(public state: State = emptyState()) {}
  describe() {
    return "memory";
  }
  async load() {
    return structuredClone(this.state);
  }
  async save(state: State, status: string) {
    this.state = structuredClone(state);
    this.saved.push({ state: this.state, status });
  }
  async notify(md: string) {
    this.notes.push(md);
  }
}
