/**
 * Teams conversations, judged message by message (docs/pipeline-refactor.md,
 * section 4.3). A Teams export is one HTML file holding many messages, each
 * one a `div.message` with `message__author`, `message__date`, `message__time`,
 * `message__recepient` and `message__content`.
 *
 * A message is a candidate when the subject is its author, its recipient or is
 * mentioned in it. Each candidate is kept with a few messages of context on
 * either side; overlapping windows form one excerpt. Whether a candidate is
 * about the subject as a person is left to the screening step that reads the
 * rendered excerpts.
 */
import crypto from "node:crypto";
import { mentionsSubject } from "./subject-rules";

/**
 * Messages kept on each side of a candidate: 2 by default, 0 to 10 through the
 * CHAT_CONTEXT_MESSAGES environment variable.
 */
export function chatContextMessages(): number {
  const value = Number(process.env.CHAT_CONTEXT_MESSAGES);
  if (!Number.isFinite(value)) return 2;
  return Math.min(10, Math.max(0, Math.round(value)));
}

export const CHAT_CONTEXT_MESSAGES = chatContextMessages();

/**
 * A conversation with at least this many messages is a "large" chat: the AI
 * screening drops it when the excerpts are about work and keeps it only when
 * they deal with a personal matter of the subject. 100 by default, 2 or more
 * through CHAT_LARGE_MESSAGES.
 */
export function chatLargeMessages(): number {
  const value = Number(process.env.CHAT_LARGE_MESSAGES);
  if (!Number.isFinite(value) || value < 2) return 100;
  return Math.round(value);
}

export const LARGE_CHAT_MARKER = "LARGE CONVERSATION";

export function isLargeChat(totalMessages: number): boolean {
  return totalMessages >= chatLargeMessages();
}

export interface ChatMessage {
  id: string;
  author: string;
  date: string;
  time: string;
  recipient: string;
  contentHtml: string;
  contentText: string;
}

export interface ChatExcerpt {
  messages: ChatMessage[];
  /** Ids of the messages in this excerpt that cite the subject (the rest is context). */
  candidateIds: Set<string>;
}

const MESSAGE_START_RE =
  /<div\s+class="\s*message\s[^"]*"[^>]*?(?:\sid="([^"]*)")?[^>]*>/gi;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));
}

function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>?/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function spanText(block: string, className: string): string {
  const match = block.match(
    new RegExp(
      `<(span|p|div)[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`,
      "i",
    ),
  );
  return match ? toText(match[2]) : "";
}

function contentOf(block: string): { html: string; text: string } {
  const open = block.match(
    /<div[^>]*class="[^"]*\bmessage__content\b[^"]*"[^>]*>/i,
  );
  if (!open || open.index === undefined) return { html: "", text: "" };
  const start = open.index + open[0].length;
  const script = block.indexOf('<script type="application/json"', start);
  let html = block.slice(start, script >= 0 ? script : undefined);
  html = html.replace(/\s*<\/div>\s*$/i, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  return { html, text: toText(html) };
}

/** Splits a Teams export into its messages; empty when the HTML is not a chat export. */
export function parseChatMessages(html: string): ChatMessage[] {
  const starts: Array<{ index: number; id: string }> = [];
  MESSAGE_START_RE.lastIndex = 0;
  for (
    let match = MESSAGE_START_RE.exec(html);
    match !== null;
    match = MESSAGE_START_RE.exec(html)
  ) {
    starts.push({ index: match.index, id: match[1] ?? "" });
  }
  const messages: ChatMessage[] = [];
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i].index, starts[i + 1]?.index);
    const content = contentOf(block);
    messages.push({
      id: starts[i].id || `m${i}`,
      author: spanText(block, "message__author"),
      date: spanText(block, "message__date"),
      time: spanText(block, "message__time"),
      recipient: spanText(block, "message__recepient"),
      contentHtml: content.html,
      contentText: content.text,
    });
  }
  return messages;
}

/** Author, recipient or content cites the subject. */
export function messageCitesSubject(
  message: ChatMessage,
  tokens: string[],
): boolean {
  return mentionsSubject(
    `${message.author}\n${message.recipient}\n${message.contentText}`,
    tokens,
  );
}

/** The candidates with `context` messages on each side, overlapping windows merged. */
export function buildExcerpts(
  messages: ChatMessage[],
  tokens: string[],
  context = CHAT_CONTEXT_MESSAGES,
  /** Candidates to leave out, for example messages already delivered in another file. */
  skip: (message: ChatMessage) => boolean = () => false,
): ChatExcerpt[] {
  const candidates = new Set<number>();
  messages.forEach((message, index) => {
    if (messageCitesSubject(message, tokens) && !skip(message)) {
      candidates.add(index);
    }
  });
  const excerpts: ChatExcerpt[] = [];
  let current: { from: number; to: number; ids: number[] } | null = null;
  const flush = () => {
    if (!current) return;
    excerpts.push({
      messages: messages.slice(current.from, current.to + 1),
      candidateIds: new Set(current.ids.map((index) => messages[index].id)),
    });
    current = null;
  };
  for (const index of [...candidates].sort((a, b) => a - b)) {
    const from = Math.max(0, index - context);
    const to = Math.min(messages.length - 1, index + context);
    if (current && from <= current.to + 1) {
      current.to = Math.max(current.to, to);
      current.ids.push(index);
    } else {
      flush();
      current = { from, to, ids: [index] };
    }
  }
  flush();
  return excerpts;
}

/** Text of an excerpt, for the keyword rule. */
export function excerptText(excerpt: ChatExcerpt): string {
  return excerpt.messages
    .map(
      (m) =>
        `${m.author} ${m.date} ${m.time}\n${m.recipient}\n${m.contentText}`,
    )
    .join("\n");
}

/** Same message in two exports: same author, time and text. */
export function messageKey(message: ChatMessage): string {
  const normalized = [
    message.author,
    message.date,
    message.time,
    message.contentText,
  ]
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `chat:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Renders the kept excerpts with a reference to the conversation they come from. */
export function renderExcerptsHtml(
  conversation: string,
  totalMessages: number,
  excerpts: ChatExcerpt[],
): string {
  const blocks = excerpts
    .map((excerpt, index) => {
      const rows = excerpt.messages
        .map((m) => {
          const cited = excerpt.candidateIds.has(m.id);
          return `<div class="msg${cited ? " cited" : ""}">
<div class="meta"><strong>${escapeHtml(m.author)}</strong> ${escapeHtml(m.date)} ${escapeHtml(m.time)}${m.recipient ? ` &rarr; ${escapeHtml(m.recipient)}` : ""}</div>
<div class="body">${m.contentHtml}</div></div>`;
        })
        .join("\n");
      return `<section><h3>Excerpt ${index + 1} of ${excerpts.length}</h3>${rows}</section>`;
    })
    .join('\n<hr class="gap" />\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${escapeHtml(conversation)}</title>
<style>
body { font-family: sans-serif; font-size: 11pt; line-height: 1.4; }
h2 { margin-bottom: 2pt; } .ref { color: #555; margin-bottom: 12pt; }
.msg { margin: 6pt 0; padding: 4pt 6pt; border-left: 2pt solid #ccc; }
.msg.cited { border-left-color: #333; }
.meta { color: #444; font-size: 9.5pt; }
hr.gap { border: 0; border-top: 1pt dashed #999; margin: 14pt 0; }
</style></head><body>
<h2>${escapeHtml(conversation)}</h2>
<div class="ref">${isLargeChat(totalMessages) ? `${LARGE_CHAT_MARKER}: ` : ""}Excerpts of a Teams conversation of ${totalMessages} messages. Messages marked with a dark bar cite the data subject; the others are context.</div>
${blocks}
</body></html>`;
}
