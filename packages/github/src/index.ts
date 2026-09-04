export interface PullRequestAuthor {
  login: string;
  name?: string;
  avatarUrl: string;
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PullRequestCheck {
  name: string;
  state: string;
  workflow?: string;
  url?: string;
}

export interface PullRequestSnapshot {
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: PullRequestAuthor;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  files: PullRequestFile[];
  checks: PullRequestCheck[];
  fetchedAt: string;
}
