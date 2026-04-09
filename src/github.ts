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
}
