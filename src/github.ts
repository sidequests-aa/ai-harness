import { Octokit } from '@octokit/rest';

export interface RepoCoords {
  owner: string;
  repo: string;
}

export interface OpenPrInput {
  coords: RepoCoords;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  /** True opens a draft PR (used for the escalation path in Phase 5). */
  draft?: boolean;
}

/**
 * Thin Octokit wrapper. Phase 1 only needs `openPr`. Phases 4-5 add issue
 * comment posting and the structured run-report renderer.
 */
export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  /** Open a PR. Returns the html_url. */
  async openPr({
    coords,
    branch,
    baseBranch,
    title,
    body,
    draft = false,
  }: OpenPrInput): Promise<string> {
    const res = await this.octokit.pulls.create({
      owner: coords.owner,
      repo: coords.repo,
      head: branch,
      base: baseBranch,
      title,
      body,
      draft,
    });
    return res.data.html_url;
  }

  /** Fetch a single issue's body markdown. Used by stage 1 in later phases. */
  async getIssueBody(coords: RepoCoords, number: number): Promise<string> {
    const res = await this.octokit.issues.get({
      owner: coords.owner,
      repo: coords.repo,
      issue_number: number,
    });
    return res.data.body ?? '';
  }

  /**
   * Sync a ticket markdown file to a GitHub issue. Find-or-create by exact
   * title match — if an issue with the same title exists, PATCH its body;
   * otherwise POST a new one. Pull requests are filtered out (the issues
   * API lists PRs too). Returns action=unchanged when bodies already match.
   */
  async syncTicket(
    coords: RepoCoords,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string; action: 'created' | 'updated' | 'unchanged' }> {
    const existing = await this.findIssueByTitle(coords, title);
    if (existing) {
      const current = await this.getIssueBody(coords, existing.number);
      if (current.trim() === body.trim()) {
        return { ...existing, action: 'unchanged' };
      }
      const res = await this.octokit.issues.update({
        owner: coords.owner,
        repo: coords.repo,
        issue_number: existing.number,
        body,
      });
      return { number: res.data.number, url: res.data.html_url, action: 'updated' };
    }
    const res = await this.octokit.issues.create({
      owner: coords.owner,
      repo: coords.repo,
      title,
      body,
    });
    return { number: res.data.number, url: res.data.html_url, action: 'created' };
  }

  private async findIssueByTitle(
    coords: RepoCoords,
    title: string,
  ): Promise<{ number: number; url: string } | null> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      owner: coords.owner,
      repo: coords.repo,
      state: 'all',
      per_page: 100,
    });
    const match = issues.find((i) => !i.pull_request && i.title === title);
    return match ? { number: match.number, url: match.html_url } : null;
  }
}
