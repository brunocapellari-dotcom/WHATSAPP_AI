import type {
  BusinessMessageHandler,
  ConversationStore,
  WhatsAppProvider,
} from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import type { AgentRuntime } from './agent-runtime.js';

export class BusinessMessageService implements BusinessMessageHandler {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly conversations?: ConversationStore,
  ) {}

  async handle(message: RawMessage, provider: WhatsAppProvider) {
    const text = message.text?.trim();
    const conversation = this.conversations
      ? await this.conversations.ensure(message)
      : undefined;

    if (!text || !message.routingAddress) {
      return {
        reply: '',
        handoff: true,
        ...(conversation ? { conversationId: conversation.conversationId } : {}),
      };
    }

    const result = await this.runtime.handleMessage(text, {
      tenantId: message.tenantId,
      role: 'agent',
      ...(conversation ? { conversationId: conversation.conversationId } : {}),
    });

    const sent = await provider.sendText({
      tenantId: message.tenantId,
      to: message.routingAddress,
      text: result.reply,
    });

    return {
      reply: result.reply,
      handoff: result.handoff,
      replyMessageId: sent.messageId,
      ...(conversation ? { conversationId: conversation.conversationId } : {}),
    };
  }
}
