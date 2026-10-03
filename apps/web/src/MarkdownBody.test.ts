import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownBody, visibleMarkdown } from "./MarkdownBody";

describe("visibleMarkdown", () => {
  it("hides bot comments that only contain metadata", () => {
    expect(visibleMarkdown("<!-- codesmith-state: complete -->\n")).toBeNull();
  });

  it("keeps the original body when visible content remains", () => {
    const body = "<!-- bot metadata -->\n\n> [!WARNING]\n> Review limit reached";
    expect(visibleMarkdown(body)).toBe(body);
  });
});

describe("MarkdownBody", () => {
  it("renders GitHub alerts, details, tables, images, and safe links", () => {
    const body = `<!-- bot metadata -->

> [!WARNING]
> Review limit reached

<details open>
<summary>Run configuration</summary>

| Plan | Profile |
| --- | --- |
| Free | Chill |

</details>

[![Review stack](https://example.com/badge.svg)](https://example.com/review)`;
    const html = renderToStaticMarkup(createElement(MarkdownBody, { body }));

    expect(html).toContain('class="markdown-alert warning"');
    expect(html).toContain("Review limit reached");
    expect(html).not.toContain("[!WARNING]");
    expect(html).toContain("<details");
    expect(html).toContain("<summary>Run configuration</summary>");
    expect(html).toContain("<table>");
    expect(html).toContain('<img src="https://example.com/badge.svg"');
    expect(html).toContain('target="_blank"');
  });
});
