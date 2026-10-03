import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const alertLabels: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), "open"],
  },
};

export function visibleMarkdown(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length === 0 ? null : body.trim();
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return "";
}

function stripAlertMarker(node: ReactNode, marker: string): ReactNode {
  if (typeof node === "string") return node.replace(marker, "").replace(/^\s*\n?/u, "");
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  const children = Children.toArray(node.props.children);
  let stripped = false;
  const nextChildren = children.map((child) => {
    if (stripped || !textContent(child).includes(marker)) return child;
    stripped = true;
    return stripAlertMarker(child, marker);
  });
  return cloneElement(node, undefined, ...nextChildren);
}

function stripAlertMarkerFromNodes(nodes: ReactNode[], marker: string): ReactNode[] {
  let stripped = false;
  return nodes.map((node) => {
    if (stripped || !textContent(node).includes(marker)) return node;
    stripped = true;
    return stripAlertMarker(node, marker);
  });
}

export function MarkdownBody({ body }: { body: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        blockquote: ({ children, node: _node, ...props }) => {
          const nodes = Children.toArray(children);
          const match = /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/u.exec(textContent(nodes));
          if (!match) return <blockquote {...props}>{children}</blockquote>;
          const kind = match[1]!;
          return (
            <div className={`markdown-alert ${kind.toLowerCase()}`} role="note">
              <strong className="alert-title">{alertLabels[kind]}</strong>
              {stripAlertMarkerFromNodes(nodes, match[0])}
            </div>
          );
        },
        details: ({ children, node: _node, ...props }) => (
          <details {...props} className="markdown-details">
            {children}
          </details>
        ),
        summary: ({ children, node: _node, ...props }) => <summary {...props}>{children}</summary>,
      }}
    >
      {body}
    </Markdown>
  );
}
