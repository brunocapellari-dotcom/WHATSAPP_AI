import type {
  BusinessMessageHandler,
  BusinessRunResult,
  BusinessRunStore,
  ConversationStore,
  WhatsAppProvider,
} from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import type { AgentRuntime } from './agent-runtime.js';

export class BusinessMessageService implements BusinessMessageHandler {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly conversations: ConversationStore,
    private readonly runs: BusinessRunStore,
  ) {}

  async handle(message: RawMessage, provider: WhatsAppProvider) {
    const conversation = await this.conversations.ensure(message);
    const claim = await this.runs.claim(message, conversation.conversationId);

    if (claim.state === 'SENT') {
      return {
        reply: claim.result.reply,
        handoff: claim.result.handoff,
        ...(claim.replyMessageId ? { replyMessageId: claim.replyMessageId } : {}),
        conversationId: conversation.conversationId,
      };
    }

    if (claim.state === 'PROCESSING') {
      return {
        reply: '',
        handoff: false,
        conversationId: conversation.conversationId,
      };
    }

    if (claim.state === 'FAILED') {
      return {
        reply: '',
        handoff: true,
        conversationId: conversation.conversationId,
      };
    }

    let result: BusinessRunResult;

    if (claim.state === 'NEW') {
      const text = message.text?.trim();
      if (!text || !message.routingAddress) {
        result = {
          reply: '',
          handoff: true,
          handoffReason: !text ? 'empty_message' : 'routing_unavailable',
        };
      } else {
        try {
          const handled = await this.runtime.handleMessage(text, {
            tenantId: message.tenantId,
            role: 'agent',
            conversationId: conversation.conversationId,
          });
          result = {
            reply: handled.reply,
            handoff: handled.handoff,
            handoffReason: handled.handoffReason ?? null,
          };
        } catch (error) {
          await this.runs.markFailed(
            message.tenantId,
            claim.runId,
            error instanceof Error ? error.message : 'business_processing_failed',
          );
          throw error;
        }
      }

      await this.runs.completeProcessing(message.tenantId, claim.runId, result);
    } else {
      result = claim.result;
    }

    if (!result.reply || !message.routingAddress) {
      return {
        reply: result.reply,
        handoff: result.handoff,
        conversationId: conversation.conversationId,
      };
    }

    const sent = await provider.sendText({
      tenantId: message.tenantId,
      to: message.routingAddress,
      text: result.reply,
    });

    await this.runs.markSent(message.tenantId, claim.runId, sent.messageId);

    return {
      reply: result.reply,
      handoff: result.handoff,
      replyMessageId: sent.messageId,
      conversationId: conversation.conversationId,
    };
  }
}
