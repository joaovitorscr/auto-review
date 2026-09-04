import { useEffect, useState } from "react";
import type { PullRequestSnapshot } from "@auto-review/github";
import { checkTone } from "./checks";

export function App() {
  const [pullRequest, setPullRequest] = useState<PullRequestSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/pr.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("No PR snapshot found");
        return response.json() as Promise<PullRequestSnapshot>;
      })
      .then(setPullRequest)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load the PR");
      });
  }, []);

  if (error) {
    return (
      <main className="empty-state">
        <p className="eyebrow">Auto-review</p>
        <h1>Load a pull request</h1>
        <p>
          Run <code>pnpm pr snapshot</code> from the repository root, then refresh this page.
        </p>
      </main>
    );
  }

  if (!pullRequest) return <main className="empty-state">Loading pull request...</main>;

  const passingChecks = pullRequest.checks.filter(
    (check) => checkTone(check.state) === "success",
  ).length;

  return (
    <main className="page-shell">
      <nav>
        <span className="wordmark">AUTO/REVIEW</span>
        <span className="repo">{pullRequest.repository}</span>
      </nav>

      <header className="hero">
        <div>
          <p className="eyebrow">Pull request {pullRequest.number}</p>
          <h1>{pullRequest.title}</h1>
          <div className="branch-row">
            <code>{pullRequest.headRefName}</code>
            <span>into</span>
            <code>{pullRequest.baseRefName}</code>
          </div>
        </div>
        <a className="github-link" href={pullRequest.url} target="_blank" rel="noreferrer">
          Open on GitHub ↗
        </a>
      </header>

      <section className="metrics" aria-label="Pull request summary">
        <article>
          <strong>{pullRequest.changedFiles}</strong>
          <span>files changed</span>
        </article>
        <article>
          <strong className="addition">+{pullRequest.additions}</strong>
          <span>additions</span>
        </article>
        <article>
          <strong className="deletion">−{pullRequest.deletions}</strong>
          <span>deletions</span>
        </article>
        <article>
          <strong>
            {passingChecks}/{pullRequest.checks.length}
          </strong>
          <span>checks passing</span>
        </article>
      </section>

      <div className="content-grid">
        <section className="panel files-panel">
          <div className="panel-heading">
            <h2>Changed files</h2>
            <span>{pullRequest.commits} commits</span>
          </div>
          <div className="file-list">
            {pullRequest.files.map((file) => (
              <div className="file-row" key={file.path}>
                <span className="file-icon">TS</span>
                <span className="file-path">{file.path}</span>
                <span className="diff">
                  <i>+{file.additions}</i> <b>−{file.deletions}</b>
                </span>
              </div>
            ))}
          </div>
        </section>

        <aside>
          <section className="panel author-card">
            <p className="eyebrow">Opened by</p>
            <div>
              <img src={pullRequest.author.avatarUrl} alt="" />
              <span>
                <strong>{pullRequest.author.name ?? pullRequest.author.login}</strong>
                <small>@{pullRequest.author.login}</small>
              </span>
            </div>
          </section>
          <section className="panel checks-panel">
            <div className="panel-heading">
              <h2>Checks</h2>
            </div>
            {pullRequest.checks.length === 0 ? (
              <p className="muted">No checks reported.</p>
            ) : (
              pullRequest.checks.map((check) => (
                <a href={check.url} className="check-row" key={`${check.workflow}-${check.name}`}>
                  <span className={`status-dot ${checkTone(check.state)}`} />
                  <span>
                    <strong>{check.name}</strong>
                    <small>{check.workflow ?? check.state.toLowerCase()}</small>
                  </span>
                </a>
              ))
            )}
          </section>
        </aside>
      </div>

      <footer>Snapshot fetched {new Date(pullRequest.fetchedAt).toLocaleString()}</footer>
    </main>
  );
}
