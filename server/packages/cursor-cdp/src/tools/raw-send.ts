import { CDP, ConnectionManager } from "../connection.js";
import { SELECTORS } from "../selectors.js";
import type { RawSendInput, RawSendOutput } from "../types.js";
import { withToolLog } from "../tool-logger.js";
import { isMacOS } from "../utils.js";

function buildFindAndFocusExpression(): string {
  const primary = JSON.stringify(SELECTORS.composer.input);
  const fallback = JSON.stringify(SELECTORS.composer.inputFallback);

  return `(() => {
    const selectors = [${primary}, ${fallback}];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.focus();
        return true;
      }
    }
    return false;
  })()`;
}

async function selectAll(client: CDP.Client): Promise<void> {
  const useMeta = isMacOS();
  const modifier = useMeta ? 4 : 2;
  const modifierKey = useMeta ? "Meta" : "Control";
  const modifierCode = useMeta ? "MetaLeft" : "ControlLeft";
  const modVk = useMeta ? 91 : 17;

  await client.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: modifierKey,
    code: modifierCode,
    windowsVirtualKeyCode: modVk,
    nativeVirtualKeyCode: modVk,
    modifiers: modifier,
  });
  await client.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: modifier,
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: modifier,
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: modifierKey,
    code: modifierCode,
    windowsVirtualKeyCode: modVk,
    nativeVirtualKeyCode: modVk,
    modifiers: 0,
  });
}

async function deleteSelection(client: CDP.Client): Promise<void> {
  await client.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46,
    nativeVirtualKeyCode: 46,
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Delete",
    code: "Delete",
    windowsVirtualKeyCode: 46,
    nativeVirtualKeyCode: 46,
  });
}

async function dispatchEnter(client: CDP.Client): Promise<void> {
  await client.Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function rawSendToolInner(
  manager: ConnectionManager,
  input: RawSendInput,
): Promise<RawSendOutput> {
  return manager.withLock(async () => {
    try {
      const client = await manager.getClient(input.port);

      const focused = await manager.evaluate(
        buildFindAndFocusExpression(),
        input.port,
      );
      if (!focused) {
        return { ok: false, error: "Composer input not found" };
      }

      await selectAll(client);
      await deleteSelection(client);
      await client.Input.insertText({ text: input.prompt });
      await dispatchEnter(client);

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }, input.port);
}

export async function rawSendTool(
  manager: ConnectionManager,
  input: RawSendInput,
): Promise<RawSendOutput> {
  return withToolLog("raw_send", { ...input }, () =>
    rawSendToolInner(manager, input),
  );
}
