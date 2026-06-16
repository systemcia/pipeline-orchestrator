/**
 * Cursor IDE DOM 选择器集中定义。
 * 来源: docs/dom-research.md（t1 调研）
 */
export const SELECTORS = {
  composer: {
    input:
      '#workbench\\.parts\\.auxiliarybar [contenteditable="true"][role="textbox"]',
    inputFallback: '.aislash-editor-input[contenteditable="true"]',
    inputAgent: '.ui-prompt-input-editor__input[contenteditable="true"]',
    // 不含 :not([disabled])，以便在生成中也能定位 Send 按钮并检测状态转换
    sendButton:
      '.composer-bar button .codicon-arrow-up, .composer-bar button .codicon-send',
    sendButtonFallback: 'button[aria-label*="Send" i]',
    sendButtonAgent: '.ui-prompt-input-submit-button',
  },
  conversation: {
    container: '#workbench\\.parts\\.auxiliarybar',
    containerAgent: '.agent-panel',
    message: '[data-flat-index]',
    lastMessage: '#workbench\\.parts\\.auxiliarybar [data-flat-index]:last-of-type',
  },
  model: {
    trigger: '.ui-model-picker__trigger',
    menu: '[role="menu"]',
    option: '[role="menuitem"], .composer-unified-context-menu-item',
  },
  status: {
    generating: '.loading-indicator-v3, .make-shine',
    spinner: '.loading-indicator-v3, [class*="loading-indicator"], [class*="spinner"]',
    stop: 'button[aria-label*="Stop" i], button .codicon-debug-stop',
    thinking: '[class*="thinking"], .make-shine',
    generatingText: 'span.auxiliary-bar-chat-title, [class*="auxiliary-bar-chat-title"]',
    loadingOverlay: '.chat-loading-overlay[role="status"], .chat-loading-overlay .codicon-loading',
  },
  askQuestion: {
    container: '.composer-questionnaire-toolbar, [class*="questionnaire-toolbar"]',
    options: '.composer-questionnaire-toolbar-option-letter',
  },
  panel: {
    root: '#workbench\\.parts\\.auxiliarybar',
    rootAgent: '.agent-panel',
  },
} as const;

export type SelectorKey = keyof typeof SELECTORS;
