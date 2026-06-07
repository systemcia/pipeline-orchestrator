/**
 * 从 read tool 返回的对话 markdown 中提取纯 AI 文本回复。
 */

const TAGGED_BLOCK_RE =
  /<(tool_call|tool_use|thinking|antml:thinking|antThinking|user_query|user_info|system_reminder|attached_files|open_and_recently_viewed_files|git_status|agent_transcripts|rules|manually_attached_skills|agent_skills|task_notification|image_files|mcp_instructions)[^>]*>[\s\S]*?<\/\1>/gi;

const REDACTED_THINKING_RE = /…+/g;

const UI_NOISE_LINE_RE =
  /^(?:Generating(?:\.\.\.)?|Thinking(?:\.\.\.)?|Running(?:\.\.\.)?|Waiting(?:\.\.\.)?|Stopping(?:\.\.\.)?|Explored\s+\d+|Searched\s+for|Searched\s+\d+|Read\s+.+|Called\s+.+|Used\s+.+|Ran\s+command|Tool:\s*.+|>\s*Ran\s+.+|Allow|Deny|Approve|Reject|Run|Skip|Continue|Stop|Cancel|Apply\s+All|Edit\s+file|View\s+diff|\d+\s+(?:files?|matches?|lines?|results?))$/i;

const TOOL_SUMMARY_LINE_RE =
  /^(?:Read|Write|Grep|Glob|Shell|Search|Called|Explored|Searched|Used|Ran)\b/i;

const THINKING_PARAGRAPH_RE =
  /^(?:(?:The user (?:wants|is |asks|said|request|mention|provided|has ))|(?:Let me (?:start|first|check|read|think|look|trace|analyze|examine|verify|now|re-|understand|plan|proceed|dig|search|investigate))|(?:Now (?:I'm |I need|I have|I understand|I can|I see|I'll|let me|looking|checking|that I))|(?:I (?:need to|should|will|can see|don't|see that|was |have |just |also |notice|'ll |think ))|(?:Looking at (?:the|this|my|how))|(?:(?:Actually|Wait|OK|Hmm),? (?:let me|I |the |looking|this))|(?:From the (?:screenshot|image|log|output|code|data))|(?:(?:So|Since|Based on|For) (?:the |this |my |I ))|(?:(?:This|That|These|They) (?:is |are |means|shows|indicates|suggests|looks|want|have |need))|(?:(?:First|Next|Then|Also|However|Overall),? (?:I |let|the |we |it ))|(?:\d+\.\s+(?:Read |Check |Verify |Trace |Find |Look |The |For |Get |Run |Then ))|(?:##\s*(?:Phase|Finding|Step|Root Cause|Pattern|Summary)))/i;

const AI_BLOCK_RE =
  /^(?:#{1,6}\s|```|(?:好的|完成|总结|以下是|我来|根据|修改|实现|已经|可以|建议|问题|方案|结论|分析|发现|编排|优化)|(?:Here(?:'s| is)|I(?:'ve| have| will)|The following|Based on|Let me (?:explain|summarize|provide)|This (?:change|update|fix|implementation)))/i;

const USER_BLOCK_RE =
  /^(?:\/[\w-]+|@(?:[\w./-]+))|<user_query>|^##\s*任务\b/i;

function removeTaggedBlocks(text: string): string {
  return text.replace(TAGGED_BLOCK_RE, "").replace(REDACTED_THINKING_RE, "");
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function filterBlockLines(block: string): string {
  const lines = block.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") {
        kept.push("");
      }
      continue;
    }
    if (UI_NOISE_LINE_RE.test(trimmed)) {
      continue;
    }
    if (TOOL_SUMMARY_LINE_RE.test(trimmed) && trimmed.length < 200) {
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isThinkingParagraph(block: string): boolean {
  const lines = block.split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    return true;
  }
  const first = lines[0]?.trim() ?? "";
  if (first.startsWith("```")) {
    return false;
  }
  return THINKING_PARAGRAPH_RE.test(first);
}

function isNoiseBlock(block: string): boolean {
  const cleaned = filterBlockLines(block);
  if (!cleaned) {
    return true;
  }
  const lines = cleaned.split("\n").filter((line) => line.trim());
  return lines.every((line) => UI_NOISE_LINE_RE.test(line.trim()));
}

function isUserBlock(block: string, index: number): boolean {
  const trimmed = block.trim();
  if (!trimmed || isNoiseBlock(trimmed)) {
    return false;
  }
  if (USER_BLOCK_RE.test(trimmed)) {
    return true;
  }
  if (AI_BLOCK_RE.test(trimmed)) {
    return false;
  }
  if (
    trimmed.includes("```") ||
    trimmed.includes("\n- ") ||
    trimmed.includes("\n* ") ||
    /^\d+\.\s/m.test(trimmed)
  ) {
    return false;
  }
  // 仅首轮短文本视为用户 prompt，避免中间 AI 段落被误判
  return index === 0 && trimmed.length <= 2000;
}

function isAiBlock(block: string, index: number): boolean {
  const trimmed = block.trim();
  if (!trimmed || isNoiseBlock(trimmed) || isThinkingParagraph(trimmed)) {
    return false;
  }
  if (isUserBlock(trimmed, index)) {
    return false;
  }
  return true;
}

function findLastUserBlockIndex(blocks: string[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (isUserBlock(blocks[i] ?? "", i)) {
      return i;
    }
  }
  return -1;
}

function extractLastRoundAiBlocks(blocks: string[]): string[] {
  const lastUserIdx = findLastUserBlockIndex(blocks);
  const startIdx = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
  const aiBlocks: string[] = [];

  for (let i = startIdx; i < blocks.length; i += 1) {
    const block = blocks[i] ?? "";
    if (isUserBlock(block, i)) {
      break;
    }
    if (isAiBlock(block, i)) {
      const cleaned = filterBlockLines(block);
      if (cleaned) {
        aiBlocks.push(cleaned);
      }
    }
  }

  return aiBlocks;
}

/**
 * 从对话 markdown 中提取最后一轮 AI 纯文本回复。
 */
export function extractResult(conversation: string): string {
  if (!conversation.trim()) {
    return "";
  }

  let text = removeTaggedBlocks(conversation);
  text = normalizeWhitespace(text);

  const blocks = splitBlocks(text);
  if (blocks.length === 0) {
    return "";
  }

  const aiBlocks = extractLastRoundAiBlocks(blocks);
  if (aiBlocks.length > 0) {
    return normalizeWhitespace(aiBlocks.join("\n\n"));
  }

  // 兜底：无法区分角色时，返回过滤后的全文
  const fallback = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => isAiBlock(block, index))
    .map(({ block }) => filterBlockLines(block))
    .filter(Boolean);

  return normalizeWhitespace(fallback.join("\n\n"));
}

