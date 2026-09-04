import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PullRequestActivity,
  PullRequestFile,
  PullRequestSnapshot,
} from "@auto-review/github";
import Markdown from "react-markdown";
import { checkTone } from "./checks";

type Tab = "summary" | "timeline" | "code";

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return formatter.format(Math.round(seconds / size), unit);
}

function Avatar({ login, url }: { login: string; url?: string }) {
  const source = url ?? `https://github.com/${encodeURIComponent(login)}.png?size=80`;
  return <img className="avatar" src={source} alt={`${login}'s avatar`} />;
}

function Diff({ file }: { file: PullRequestFile }) {
  if (!file.patch)
    return (
      <p className="empty-copy">
        GitHub did not include this patch. It may be binary or too large.
      </p>
    );
  return (
    <pre className="patch">
      {file.patch.split("\n").map((line, index) => {
        const tone =
          line.startsWith("+") && !line.startsWith("+++")
            ? "added"
            : line.startsWith("-") && !line.startsWith("---")
              ? "removed"
              : line.startsWith("@@")
                ? "hunk"
                : "context";
        return (
          <span className={tone} key={`${index}-${line}`}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

function Summary({ pullRequest }: { pullRequest: PullRequestSnapshot }) {
  return (
    <div className="tab-page">
      <section className="summary-meta">
        <div>
          <span>Reviewers</span>
          <strong>None requested</strong>
        </div>
        <div>
          <span>Labels</span>
          <strong>{pullRequest.labels?.map((label) => label.name).join(", ") || "None"}</strong>
        </div>
        <div>
          <span>Activity</span>
          <strong>{pullRequest.activity?.length ?? 0} events</strong>
        </div>
      </section>
      <section className="content-section">
        <h2>Description</h2>
        <div className="markdown-body">
          <Markdown>{pullRequest.body || "No description provided."}</Markdown>
        </div>
      </section>
      <section className="content-section">
        <h2>
          Checks <span>{pullRequest.checks.length}</span>
        </h2>
        <div className="checks-list">
          {pullRequest.checks.length === 0 ? (
            <p className="empty-copy">No checks reported.</p>
          ) : (
            pullRequest.checks.map((check) => (
              <a
                href={check.url}
                className="check"
                key={`${check.workflow}-${check.name}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className={`status-icon ${checkTone(check.state)}`} />
                <strong>{check.name}</strong>
                <span>{check.state.toLowerCase().replaceAll("_", " ")}</span>
              </a>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function ActivityCard({ event }: { event: PullRequestActivity }) {
  const action =
    event.type === "commit"
      ? "committed"
      : event.type === "review"
        ? event.state?.toLowerCase().replaceAll("_", " ")
        : "commented";
  return (
    <article className="activity-card">
      <Avatar login={event.author.login} url={event.author.avatarUrl} />
      <div className="activity-content">
        <header>
          <strong>{event.author.login}</strong>
          <span>{action}</span>
          <time>{relativeTime(event.createdAt)}</time>
        </header>
        {event.commitOid && <code>{event.commitOid.slice(0, 7)}</code>}
        {event.body && (
          <div className="markdown-body compact">
            <Markdown>{event.body}</Markdown>
          </div>
        )}
      </div>
      {event.url && (
        <a
          className="event-link"
          href={event.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open on GitHub"
        >
          ↗
        </a>
      )}
    </article>
  );
}

function Timeline({ activity = [] }: { activity?: PullRequestActivity[] }) {
  return (
    <div className="tab-page timeline-page">
      <div className="section-title">
        <h2>Timeline</h2>
        <span>{activity.length} events · oldest first</span>
      </div>
      <div className="timeline-line">
        {activity.length === 0 ? (
          <p className="empty-copy">No timeline activity in this snapshot.</p>
        ) : (
          activity.map((event) => <ActivityCard event={event} key={`${event.type}-${event.id}`} />)
        )}
      </div>
    </div>
  );
}

function Code({ files }: { files: PullRequestFile[] }) {
  const fileRefs = useRef(new Map<string, HTMLElement>());
  return (
    <div className="code-layout">
      <aside className="file-nav">
        <div className="file-nav-title">
          Files <span>{files.length}</span>
        </div>
        {files.map((file) => (
          <button
            key={file.path}
            onClick={() =>
              fileRefs.current
                .get(file.path)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            <span>{file.path}</span>
            <i>
              +{file.additions} −{file.deletions}
            </i>
          </button>
        ))}
      </aside>
      <div className="diff-scroll">
        {files.map((file) => (
          <section
            className="diff-file"
            key={file.path}
            ref={(element) => {
              if (element) fileRefs.current.set(file.path, element);
            }}
          >
            <header>
              <div>
                <span className="file-badge">{file.status?.slice(0, 1).toUpperCase() ?? "M"}</span>
                <strong>{file.path}</strong>
              </div>
              <span className="diff-stat">
                <i>+{file.additions}</i>
                <b>−{file.deletions}</b>
              </span>
            </header>
            <Diff file={file} />
          </section>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const [pullRequest, setPullRequest] = useState<PullRequestSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  useEffect(() => {
    fetch("/pr.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("No PR snapshot found");
        return response.json() as Promise<PullRequestSnapshot>;
      })
      .then(setPullRequest)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Could not load the PR"),
      );
  }, []);
  const checkSummary = useMemo(() => {
    if (!pullRequest) return "";
    const passing = pullRequest.checks.filter(
      (check) => checkTone(check.state) === "success",
    ).length;
    return `${passing} of ${pullRequest.checks.length} passing`;
  }, [pullRequest]);
  if (error)
    return (
      <main className="empty-state">
        <p className="eyebrow">Auto-review</p>
        <h1>Load a pull request</h1>
        <p>
          Run <code>pnpm pr snapshot</code> from the repository root, then refresh this page.
        </p>
      </main>
    );
  if (!pullRequest) return <main className="empty-state">Loading pull request...</main>;
  return (
    <main className="pr-shell">
      <header className="pr-header">
        <div className="pr-title-row">
          <div>
            <a href={pullRequest.url} target="_blank" rel="noreferrer">
              #{pullRequest.number} ↗
            </a>
            <h1>{pullRequest.title}</h1>
          </div>
          <span className={`state-pill ${pullRequest.state.toLowerCase()}`}>
            {pullRequest.isDraft ? "Draft" : pullRequest.state.toLowerCase()}
          </span>
        </div>
        <div className="pr-subtitle">
          <span className="author">
            <Avatar login={pullRequest.author.login} url={pullRequest.author.avatarUrl} />
            {pullRequest.author.login}
          </span>
          <span>{relativeTime(pullRequest.updatedAt ?? pullRequest.fetchedAt)}</span>
          <code>
            {pullRequest.baseRefName} ← {pullRequest.headRefName}
          </code>
          <span className="header-stats">
            ▧ {pullRequest.changedFiles} <i>+{pullRequest.additions}</i>{" "}
            <b>−{pullRequest.deletions}</b>
          </span>
        </div>
      </header>
      <nav className="tabs" aria-label="Pull request sections">
        <div>
          {(["summary", "timeline", "code"] as const).map((value) => (
            <button
              className={tab === value ? "active" : ""}
              key={value}
              onClick={() => setTab(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <span>
          <i className="status-icon pending" /> {checkSummary}
        </span>
      </nav>
      <div className="tab-scroll">
        {tab === "summary" && <Summary pullRequest={pullRequest} />}
        {tab === "timeline" && <Timeline activity={pullRequest.activity} />}
        {tab === "code" && <Code files={pullRequest.files} />}
      </div>
    </main>
  );
}
