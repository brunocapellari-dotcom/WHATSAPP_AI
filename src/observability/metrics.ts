import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

export class Metrics {
  readonly registry = new Registry();
  readonly messages = new Counter({ name: 'whatsapp_ai_messages_total', help: 'Inbound messages', labelNames: ['provider','disposition'], registers: [this.registry] });
  readonly failures = new Counter({ name: 'whatsapp_ai_failures_total', help: 'Failures', labelNames: ['component'], registers: [this.registry] });
  readonly aiLatency = new Histogram({ name: 'whatsapp_ai_ai_latency_seconds', help: 'AI latency', labelNames: ['operation'], registers: [this.registry] });
  readonly toolFailures = new Counter({ name: 'whatsapp_ai_tool_failures_total', help: 'Tool failures', labelNames: ['tool'], registers: [this.registry] });
  readonly duplicateRate = new Counter({ name: 'whatsapp_ai_duplicates_total', help: 'Duplicate messages/offers', labelNames: ['kind'], registers: [this.registry] });
  readonly queueLag = new Gauge({ name: 'whatsapp_ai_queue_lag', help: 'Queue lag', labelNames: ['queue'], registers: [this.registry] });
  readonly collectorHealth = new Gauge({ name: 'whatsapp_ai_collector_health', help: 'Collector health 1/0', labelNames: ['collector','provider'], registers: [this.registry] });
  constructor() { collectDefaultMetrics({ register: this.registry, prefix: 'whatsapp_ai_' }); }
}
