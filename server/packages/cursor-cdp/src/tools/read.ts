import { ConnectionManager } from "../connection.js";
import { SELECTORS } from "../selectors.js";
import type { ReadInput, ReadOutput } from "../types.js";
import { withToolLog } from "../tool-logger.js";

function buildReadExpression(): string {
  const containerSel = JSON.stringify(SELECTORS.conversation.container);
  const messageSel = JSON.stringify(SELECTORS.conversation.message);

  return `(() => {
    const container = document.querySelector(${containerSel});
    if (!container) {
      return { conversation: "", last_message: "", message_count: 0 };
    }

    const messages = container.querySelectorAll(${messageSel});
    const messageCount = messages.length;

    function htmlToMarkdown(root) {
      const clone = root.cloneNode(true);

      clone.querySelectorAll("style, script").forEach((el) => el.remove());

      clone
        .querySelectorAll(
          '[data-message-kind="tool"], [class*="ui-tool-call"], [class*="composer-"][class*="-tool"]',
        )
        .forEach((el) => el.remove());

      clone
        .querySelectorAll(
          'details, [class*="collapse"], [class*="collapsible"], [class*="folded"]',
        )
        .forEach((el) => el.remove());

      clone
        .querySelectorAll(
          '.composer-bar, .loading-indicator-v3, .make-shine, .composer-questionnaire-toolbar, button, [contenteditable="true"]',
        )
        .forEach((el) => el.remove());

      const tick = String.fromCharCode(96);

      clone.querySelectorAll("pre").forEach((pre) => {
        const code = pre.querySelector("code");
        const text = (code || pre).textContent || "";
        const langMatch = code?.className?.match(/language-(\\w+)/);
        const lang = langMatch ? langMatch[1] : "";
        const fence =
          "\\n" +
          tick +
          tick +
          tick +
          lang +
          "\\n" +
          text.trim() +
          "\\n" +
          tick +
          tick +
          tick +
          "\\n";
        pre.replaceWith(document.createTextNode(fence));
      });

      clone.querySelectorAll("code").forEach((code) => {
        const text = code.textContent || "";
        code.replaceWith(document.createTextNode(tick + text + tick));
      });

      clone.querySelectorAll("br").forEach((br) => {
        br.replaceWith(document.createTextNode("\\n"));
      });

      clone.querySelectorAll("p").forEach((p) => {
        const text = (p.textContent || "").trim();
        if (text) {
          p.replaceWith(document.createTextNode("\\n\\n" + text + "\\n\\n"));
        } else {
          p.remove();
        }
      });

      let text = (clone.textContent || "")
        .replace(/[ \\t]+\\n/g, "\\n")
        .replace(/\\n{3,}/g, "\\n\\n")
        .trim();

      return text;
    }

    const conversation = htmlToMarkdown(container);

    const lastEl = messages[messageCount - 1];
    const lastMessage = lastEl ? htmlToMarkdown(lastEl) : "";

    return {
      conversation,
      last_message: lastMessage,
      message_count: messageCount,
    };
  })()`;
}

async function readToolInner(
  manager: ConnectionManager,
  input: ReadInput,
): Promise<ReadOutput> {
  const result = (await manager.evaluate(
    buildReadExpression(),
    input.port,
  )) as ReadOutput | null;

  return {
    conversation: result?.conversation ?? "",
    last_message: result?.last_message ?? "",
    message_count: result?.message_count ?? 0,
  };
}

export async function readTool(
  manager: ConnectionManager,
  input: ReadInput,
): Promise<ReadOutput> {
  return withToolLog("read", input as Record<string, unknown>, () =>
    readToolInner(manager, input),
  );
}
