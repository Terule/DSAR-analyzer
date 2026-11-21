import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type FileDecision,
  runStandaloneBatch,
} from "../../../src/lib/standalone-processor";
import { buildSubjectTokens } from "../../../src/lib/subject-rules";
import {
  buildExcerpts,
  isLargeChat,
  LARGE_CHAT_MARKER,
  messageKey,
  parseChatMessages,
  renderExcerptsHtml,
} from "../../../src/lib/teams-chat";

function message(
  n: number,
  author: string,
  text: string,
  recipient = "",
): string {
  return `<div class="
        message 
        message--chat" id="id-${n}">
  <h1 class="message__header">
    <span class="message__author">${author}</span>
    <span class="message__date-item-wrapper">
      <span class="message__date">1/${n}/2025</span>
      <span class="message__time">10:${String(n).padStart(2, "0")} AM</span>
    </span>
  </h1>
  <p class="message__recepient">${recipient}</p>
  <div class="message__content" dir="auto">
    <p class="message__content-paragraph"><div>${text}</div></p>
  </div>
<script type="application/json"><![CDATA[{"ItemData":"{}"}]]></script>
</div>`;
}

function chat(messages: string[]): string {
  return `<!DOCTYPE html><html><head><style>body{}</style></head><body>\n${messages.join("\n")}\n</body></html>`;
}

const tokens = buildSubjectTokens({
  name: "Maria Souza",
  email: "maria.souza@corp.com",
});

/** 12 messages; only the 6th (index 5) cites the subject. */
function conversation(extra: Record<number, string> = {}): string {
  return chat(
    Array.from({ length: 12 }, (_, i) =>
      message(
        i,
        "Alice Jones <alice@corp.com>",
        extra[i] ?? `Filler number ${i} about nothing`,
      ),
    ),
  );
}

describe("parsing a Teams export", () => {
  it("splits the messages and reads author, time and text", () => {
    const messages = parseChatMessages(
      chat([
        message(1, "Alice &lt;alice@corp.com&gt;", "Hello &amp; welcome"),
        message(2, "Bob", "Second", "Maria"),
      ]),
    );
    assert.equal(messages.length, 2);
    assert.equal(messages[0].author, "Alice <alice@corp.com>");
    assert.equal(messages[0].contentText, "Hello & welcome");
    assert.equal(messages[0].time, "10:01 AM");
    assert.equal(messages[1].recipient, "Maria");
  });

  it("finds no messages in HTML that is not a chat", () => {
    assert.deepEqual(
      parseChatMessages("<html><body><p>Hi</p></body></html>"),
      [],
    );
  });
});

describe("excerpts around the subject", () => {
  const messages = parseChatMessages(
    conversation({ 5: "Maria asked for leave next week" }),
  );

  it("keeps the citing message with two messages on each side", () => {
    const excerpts = buildExcerpts(messages, tokens);
    assert.equal(excerpts.length, 1);
    assert.deepEqual(
      excerpts[0].messages.map((m) => m.id),
      ["id-3", "id-4", "id-5", "id-6", "id-7"],
    );
    assert.deepEqual([...excerpts[0].candidateIds], ["id-5"]);
  });

  it("merges overlapping windows and keeps distant ones apart", () => {
    const many = parseChatMessages(
      conversation({ 2: "Maria here", 4: "Maria again", 10: "thanks Maria" }),
    );
    const excerpts = buildExcerpts(many, tokens);
    assert.equal(excerpts.length, 2);
    assert.deepEqual(
      excerpts[0].messages.map((m) => m.id),
      ["id-0", "id-1", "id-2", "id-3", "id-4", "id-5", "id-6"],
    );
  });

  it("counts the subject as author or recipient too", () => {
    const parsed = parseChatMessages(
      chat([
        message(0, "Zed", "nothing"),
        message(1, "Maria Souza <maria.souza@corp.com>", "I will be out"),
        message(2, "Zed", "nothing", "Maria Souza"),
      ]),
    );
    const excerpts = buildExcerpts(parsed, tokens, 0);
    // Neighbouring windows form one excerpt; message 0 never cites the subject.
    assert.equal(excerpts.length, 1);
    assert.deepEqual([...excerpts[0].candidateIds], ["id-1", "id-2"]);
  });

  it("the same message in two exports has the same key", () => {
    assert.equal(
      messageKey(messages[5]),
      messageKey(
        parseChatMessages(
          conversation({ 5: "Maria asked for leave next week" }),
        )[5],
      ),
    );
  });
});

describe("the Files engine on Teams exports", () => {
  async function run(files: Record<string, string>) {
    const input = fs.mkdtempSync(path.join(os.tmpdir(), "teams-in-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "teams-out-"));
    const paths = Object.entries(files).map(([name, content]) => {
      const file = path.join(input, name);
      fs.writeFileSync(file, content);
      return file;
    });
    const decisions: FileDecision[] = [];
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await runStandaloneBatch({
        inputDir: input,
        filePaths: paths,
        messagesDir: path.join(out, "Messages"),
        documentsDir: path.join(out, "Documents"),
        subjectCriteria: {
          name: "Maria Souza",
          email: "maria.souza@corp.com",
          personalEmail: "msouza@gmail.com",
        },
        onDecision: (d) => {
          if (d.state === "discarded") decisions.push(d);
        },
      });
    } finally {
      console.log = original;
    }
    const delivered = fs.existsSync(path.join(out, "Messages"))
      ? fs.readdirSync(path.join(out, "Messages"))
      : [];
    return { decisions, logs: logs.join("\n"), delivered };
  }

  it("keeps a conversation the subject wrote in (no authored-by-subject discard)", async () => {
    const result = await run({
      "a.html": chat([
        message(0, "Maria Souza <maria.souza@corp.com>", "Booking my leave"),
        message(1, "Alice", "Approved"),
      ]),
    });
    assert.deepEqual(result.decisions, []);
    assert.equal(result.delivered.length, 1);
  });

  it("renders only the excerpt, not the whole conversation", async () => {
    const result = await run({
      "a.html": conversation({ 5: "Maria asked for leave next week" }),
    });
    assert.match(result.logs, /kept 1 excerpt\(s\) around 1 message\(s\)/);
    assert.equal(result.delivered.length, 1);
  });

  it("discards a conversation that never cites the subject", async () => {
    const result = await run({ "a.html": conversation() });
    assert.deepEqual(
      result.decisions.map((d) => d.rule),
      ["subject_absent"],
    );
  });

  it("applies the keyword rule per excerpt, keeping the clean one", async () => {
    const result = await run({
      "a.html": conversation({
        1: "Maria, this is Privileged advice",
        10: "Maria, lunch tomorrow?",
      }),
    });
    assert.deepEqual(result.decisions, []);
    assert.match(result.logs, /kept 1 excerpt\(s\)/);
  });

  it("discards when every excerpt has the keyword", async () => {
    const result = await run({
      "a.html": conversation({ 5: "Maria, Privileged advice" }),
    });
    assert.deepEqual(
      result.decisions.map((d) => d.rule),
      ["keyword"],
    );
  });

  it("does not deliver the same messages twice from two exports", async () => {
    const same = conversation({ 5: "Maria asked for leave next week" });
    const result = await run({
      "a.html": same,
      "b.html": `${same}<!-- re-export -->`,
    });
    assert.equal(result.delivered.length, 1);
    assert.deepEqual(
      result.decisions.map((d) => d.rule),
      ["dup"],
    );
  });

  it("treats HTML that is not a chat as a document", async () => {
    const result = await run({
      "page.html": "<html><body><p>Notes about Maria Souza</p></body></html>",
      "other.html": "<html><body><p>Catering invoice</p></body></html>",
    });
    assert.deepEqual(
      result.decisions.map((d) => d.rule),
      ["subject_absent"],
    );
  });
});

describe("per-message audit decisions", () => {
  it("reports each message that cites the subject, with neutral labels", async () => {
    const input = fs.mkdtempSync(path.join(os.tmpdir(), "msgs-in-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "msgs-out-"));
    const file = path.join(input, "a.html");
    fs.writeFileSync(
      file,
      conversation({
        1: "Maria, this is Privileged advice",
        10: "Maria, lunch tomorrow?",
      }),
    );
    const decisions: FileDecision[] = [];
    const original = console.log;
    console.log = () => {};
    try {
      await runStandaloneBatch({
        inputDir: input,
        filePaths: [file],
        messagesDir: path.join(out, "Messages"),
        documentsDir: path.join(out, "Documents"),
        subjectCriteria: { name: "Maria Souza", email: "maria.souza@corp.com" },
        onDecision: (d) => decisions.push(d),
      });
    } finally {
      console.log = original;
    }
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].state, "kept");
    const messages = decisions[0].messages ?? [];
    assert.deepEqual(
      messages.map((m) => [m.label, m.state, m.rule]),
      [
        ["Message 2 of 12", "discarded", "keyword"],
        ["Message 11 of 12", "kept", "chat_excerpt"],
      ],
    );
    // No author, no text: labels are positions only.
    for (const m of messages) assert.doesNotMatch(m.label, /Alice|lunch/i);
  });

  it("the context size is configurable and clamped", async () => {
    const { chatContextMessages } = await import("../../../src/lib/teams-chat");
    const previous = process.env.CHAT_CONTEXT_MESSAGES;
    try {
      process.env.CHAT_CONTEXT_MESSAGES = "4";
      assert.equal(chatContextMessages(), 4);
      process.env.CHAT_CONTEXT_MESSAGES = "99";
      assert.equal(chatContextMessages(), 10);
      process.env.CHAT_CONTEXT_MESSAGES = "-3";
      assert.equal(chatContextMessages(), 0);
      process.env.CHAT_CONTEXT_MESSAGES = "nope";
      assert.equal(chatContextMessages(), 2);
    } finally {
      if (previous === undefined) delete process.env.CHAT_CONTEXT_MESSAGES;
      else process.env.CHAT_CONTEXT_MESSAGES = previous;
    }
  });
});

describe("large conversations", () => {
  it("tell the screening when a chat is large", () => {
    const html = (total: number) =>
      renderExcerptsHtml(
        "chat.html",
        total,
        buildExcerpts(
          parseChatMessages(message(1, "Jon Wheeler", "hello")),
          tokens,
        ),
      );
    assert.ok(html(100).includes(LARGE_CHAT_MARKER));
    assert.ok(!html(99).includes(LARGE_CHAT_MARKER));
    assert.equal(isLargeChat(100), true);
    assert.equal(isLargeChat(10), false);
  });
});
