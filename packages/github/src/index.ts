export interface PullRequestAuthor {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
  diffUrl?: string;
  status?: string;
  patch?: string;
}

export interface PullRequestActivity {
  id: string;
  type: "comment" | "review" | "commit";
  author: PullRequestAuthor;
  body: string;
  state?: string;
  url?: string;
  createdAt: string;
  commitOid?: string;
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
  labels: Array<{ name: string; color: string }>;
  activity: PullRequestActivity[];
  createdAt: string;
  updatedAt: string;
  fetchedAt: string;
}
