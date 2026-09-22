import type {
  BusinessMessageHandler,
  BusinessRunResult,
  BusinessRunStore,
  ConversationStore,
  WhatsAppProvider,
} from '../domain/ports.js';
import type { RawMessage } from '../domain/schemas.js';
import { isProviderSendError } from '../providers/errors.js';
import type { AgentRuntime } from './agent-runtime.js';

export class BusinessMessageService implements BusinessMessageHandler {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly conversations: ConversationStore,
    private readonly runs: BusinessRunStore,
  ) {}

  async handle(message: RawMessage, provider: WhatsAppProvider) {
    const conversation = await this.conversations.ensure(message);
    const context = {
      tenantId: message.tenantId,
      role: 'agent' as const,
      conversationId: conversation.conversationId,
    };

    if (conversation.state === 'WAITING_HUMAN' || conversation.state === 'HUMAN') {
      return {
        reply: '',
        handoff: true,
        conversationId: conversation.conversationId,
      };
    }

    if (conversation.state === 'CLOSED') {
      return {
        reply: '',
        handoff: false,
        conversationId: conversation.conversationId,
      };
    }

    const claim = await this.runs.claim(message, conversation.conversationId);

    if (claim.state === 'SENT') {
      return {
        reply: claim.result.reply,
        handoff: claim.result.handoff,
        ...(claim.replyMessageId ? { replyMessageId: claim.replyMessageId } : {}),
        conversationId: conversation.conversationId,
      };
    }

    if (claim.state === 'PROCESSING' || claim.state === 'SENDING') {
      // Another worker may still own an active business step. Keep the webhook
      // retryable instead of ACKing and losing recovery of an abandoned run.
      throw new Error(`business_run_${claim.state.toLowerCase()}_in_progress`);
    }

    if (claim.state === 'DELIVERY_UNCERTAIN') {
      const handoff = await this.runtime.forceHandoff('delivery_uncertain', context);
      if (!handoff.persisted) throw new Error('human_handoff_persistence_failed');
      return {
        reply: '',
        handoff: true,
        conversationId: conversation.conversationId,
      };
    }

    let result: BusinessRunResult;

    if (claim.state === 'FAILED') {
      const handoff = await this.runtime.forceHandoff('previous_processing_uncertain', context);
      if (!handoff.persisted) throw new Error('human_handoff_persistence_failed');
      result = {
        reply: 'Não consegui confirmar com segurança a etapa anterior. O atendimento foi encaminhado para revisão humana.',
        handoff: true,
        handoffReason: 'previous_processing_uncertain',
      };
      await this.runs.completeProcessing(message.tenantId, claim.runId, result);
    } else if (claim.state === 'NEW') {
      const text = message.text?.trim();
      if (!text || !message.routingAddress) {
        const reason = !text ? 'empty_message' : 'routing_unavailable';
        const handoff = await this.runtime.forceHandoff(reason, context);
        if (!handoff.persisted) throw new Error('human_handoff_persistence_failed');
        result = {
          reply: '',
          handoff: true,
          handoffReason: reason,
        };
      } else {
        try {
          const handled = await this.runtime.handleMessage(text, context);
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

    if (!result.reply) {
      await this.runs.markNoSendCompleted(message.tenantId, claim.runId);
      return {
        reply: '',
        handoff: result.handoff,
        conversationId: conversation.conversationId,
      };
    }

    if (!message.routingAddress) {
      const handoff = await this.runtime.forceHandoff('routing_unavailable', context);
      if (!handoff.persisted) throw new Error('human_handoff_persistence_failed');
      throw new Error('routing_unavailable_for_pending_reply');
    }

    await this.runs.beginSend(message.tenantId, claim.runId);

    let sent: { messageId: string };
    try {
      sent = await provider.sendText({
        tenantId: message.tenantId,
        to: message.routingAddress,
        text: result.reply,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'provider_send_failed';
      if (isProviderSendError(error) && !error.deliveryUncertain) {
        await this.runs.markSendRetryable(message.tenantId, claim.runId, errorMessage);
        throw error;
      }

      await this.runs.markDeliveryUncertain(
        message.tenantId,
        claim.runId,
        errorMessage,
      );
      const handoff = await this.runtime.forceHandoff('delivery_uncertain', context);
      if (!handoff.persisted) throw new Error('human_handoff_persistence_failed');

      return {
        reply: '',
        handoff: true,
        conversationId: conversation.conversationId,
      };
    }

    try {
      await this.runs.markSent(message.tenantId, claim.runId, sent.messageId);
    } catch (error) {
      // The provider returned a message id, therefore resending would risk a
      // duplicate customer message. Preserve that uncertainty for human review.
      await this.runs.markDeliveryUncertain(
        message.tenantId,
        claim.runId,
        `provider_acknowledged_but_persistence_failed:${sent.messageId}`,
      );
      const handoff = await this.runtime.forceHandoff('delivery_uncertain', context);
      if (!handoff.persisted) throw new Error('human_handoff_persistence_failed');
      return {
        reply: '',
        handoff: true,
        conversationId: conversation.conversationId,
      };
    }

    return {
      reply: result.reply,
      handoff: result.handoff,
      replyMessageId: sent.messageId,
      conversationId: conversation.conversationId,
    };
  }
}
