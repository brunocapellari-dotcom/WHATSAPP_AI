import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { AiUsageSample } from './ai-usage.js';

export class Metrics {
  readonly registry = new Registry();
  readonly messages = new Counter({ name: 'whatsapp_ai_messages_total', help: 'Processed inbound messages', labelNames: ['provider','disposition'], registers: [this.registry] });
  readonly webhookIngress = new Counter({ name: 'whatsapp_ai_webhook_ingress_total', help: 'Authenticated webhook envelopes accepted into durable inbox', labelNames: ['provider','outcome'], registers: [this.registry] });
  readonly reconciliationMessages = new Counter({ name: 'whatsapp_ai_reconciliation_messages_total', help: 'Messages observed by provider reconciliation', labelNames: ['provider','outcome'], registers: [this.registry] });
  readonly failures = new Counter({ name: 'whatsapp_ai_failures_total', help: 'Failures', labelNames: ['component'], registers: [this.registry] });
  readonly aiRequests = new Counter({ name: 'whatsapp_ai_ai_requests_total', help: 'AI requests', labelNames: ['operation','model'], registers: [this.registry] });
  readonly aiLatency = new Histogram({ name: 'whatsapp_ai_ai_latency_seconds', help: 'AI request latency', labelNames: ['operation','model'], registers: [this.registry] });
  readonly aiInputTokens = new Counter({ name: 'whatsapp_ai_ai_input_tokens_total', help: 'AI input tokens', labelNames: ['operation','model'], registers: [this.registry] });
  readonly aiCachedInputTokens = new Counter({ name: 'whatsapp_ai_ai_cached_input_tokens_total', help: 'AI cached input tokens', labelNames: ['operation','model'], registers: [this.registry] });
  readonly aiOutputTokens = new Counter({ name: 'whatsapp_ai_ai_output_tokens_total', help: 'AI output tokens', labelNames: ['operation','model'], registers: [this.registry] });
  readonly toolFailures = new Counter({ name: 'whatsapp_ai_tool_failures_total', help: 'Tool failures', labelNames: ['tool'], registers: [this.registry] });
  readonly duplicateRate = new Counter({ name: 'whatsapp_ai_duplicates_total', help: 'Duplicate messages/offers', labelNames: ['kind'], registers: [this.registry] });
  readonly queueLag = new Gauge({ name: 'whatsapp_ai_queue_lag', help: 'Queue lag', labelNames: ['queue'], registers: [this.registry] });
  readonly collectorHealth = new Gauge({ name: 'whatsapp_ai_collector_health', help: 'Collector health 1/0', labelNames: ['collector','provider'], registers: [this.registry] });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'whatsapp_ai_' });
  }

  observeAi(sample: AiUsageSample): void {
    const labels = { operation: sample.operation, model: sample.model };
    this.aiRequests.inc(labels);
    this.aiLatency.observe(labels, sample.latencySeconds);
    if (sample.inputTokens !== undefined) this.aiInputTokens.inc(labels, sample.inputTokens);
    if (sample.cachedInputTokens !== undefined) this.aiCachedInputTokens.inc(labels, sample.cachedInputTokens);
    if (sample.outputTokens !== undefined) this.aiOutputTokens.inc(labels, sample.outputTokens);
  }
}
