import { BailianMemoryService, memoryConfig } from "./bailian.js";
import { Store } from "./db.js";
import { uid } from "./security.js";
import { MemorySyncState, MessageRecord } from "./types.js";

function now() {
  return new Date().toISOString();
}

function chars(messages: Pick<MessageRecord, "content">[]) {
  return messages.reduce((total, message) => total + message.content.length, 0);
}

function shouldSubmit(state: MemorySyncState | undefined, messages: MessageRecord[]) {
  if (!messages.length) return false;
  if (state?.lastSubmittedAt) {
    const elapsed = Date.now() - new Date(state.lastSubmittedAt).getTime();
    if (elapsed < memoryConfig.scanIntervalMinutes * 60_000) return false;
  }
  return messages.length >= memoryConfig.minNewMessages || chars(messages) >= memoryConfig.minNewChars;
}

export class MemorySyncScheduler {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private store: Store,
    private memoryService = new BailianMemoryService()
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), memoryConfig.scanIntervalMinutes * 60_000);
  }

  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const db = await this.store.read();
      const conversations = db.conversations.slice().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const conversation of conversations) {
        const state = db.memorySyncStates.find((item) => item.conversationId === conversation.id);
        const allMessages = db.messages
          .filter((message) => message.conversationId === conversation.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const startIndex = state?.lastSubmittedMessageId
          ? allMessages.findIndex((message) => message.id === state.lastSubmittedMessageId) + 1
          : 0;
        const pending = allMessages.slice(Math.max(0, startIndex), Math.max(0, startIndex) + memoryConfig.maxMessagesPerBatch);
        if (!shouldSubmit(state, pending)) continue;
        await this.submitBatch(pending).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  async submitConversation(conversationId: string, limit = memoryConfig.maxMessagesPerBatch) {
    const db = await this.store.read();
    const messages = db.messages
      .filter((message) => message.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit);
    if (!messages.length) throw new Error("对话没有可保存的消息");
    await this.submitBatch(messages);
  }

  private async submitBatch(messages: MessageRecord[]) {
    const first = messages[0];
    const last = messages[messages.length - 1];
    await this.memoryService.addMemory({
      companyId: first.companyId,
      userId: first.userId,
      messages: messages.map(({ role, content, createdAt }) => ({ role, content, createdAt })),
      metadata: {
        visibility: "implicit",
        source: "auto_conversation",
        company_id: first.companyId,
        conversation_id: first.conversationId,
        batch_id: uid("mbt"),
        first_message_at: first.createdAt,
        last_message_at: last.createdAt,
        message_count: messages.length
      }
    });
    await this.store.mutate((db) => {
      const current = now();
      let state = db.memorySyncStates.find((item) => item.conversationId === first.conversationId);
      if (!state) {
        state = {
          id: uid("mss"),
          companyId: first.companyId,
          userId: first.userId,
          conversationId: first.conversationId,
          createdAt: current,
          updatedAt: current
        };
        db.memorySyncStates.push(state);
      }
      state.lastSubmittedMessageId = last.id;
      state.lastSubmittedAt = current;
      state.updatedAt = current;
      return state;
    });
  }
}
