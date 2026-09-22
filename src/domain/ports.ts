import type { FreightEvent, FreightFields, FreightObservation, OutboxEvent, ProviderCapabilities, RawMessage } from './schemas.js';
export type ReconciliationPayload={payload:unknown;chatAddress:string|null;isGroup:boolean};
export interface WhatsAppProvider { readonly id:string; readonly accountId?:string; readonly capabilities:ProviderCapabilities; sendText(input:{tenantId:string;to:string;text:string}):Promise<{messageId:string}>; normalizeInbound(input:unknown,context:{tenantId:string;collectorId:string}):Promise<RawMessage[]>; health():Promise<{ok:boolean;details?:Record<string,unknown>}>; downloadMedia?(reference:string,options?:{maxBytes:number}):Promise<DownloadedMedia>; fetchReconciliationBatch?():Promise<ReconciliationPayload[]>; markChatSeen?(chatAddress:string,isGroup:boolean):Promise<void>; }
export interface StructuredLanguageModel { extractFreight(text:string):Promise<Partial<FreightFields>>; classifyRelevance(text:string):Promise<{relevant:boolean;confidence:number;reason:string}>; }
export interface MessageRepository { saveRaw(message:RawMessage):Promise<{status:'inserted'|'duplicate';eventId:string}>; saveObservation(observation:FreightObservation):Promise<void>; findFreightEventByFingerprint(tenantId:string,fingerprint:string):Promise<FreightEvent|null>; saveFreightEvent(event:FreightEvent):Promise<void>; mergeFreightEvent(tenantId:string,fingerprint:string,merge:(existing:FreightEvent|null)=>FreightEvent):Promise<FreightEvent>; enqueueOutbox(event:OutboxEvent):Promise<void>; }
export interface EntityResolver { resolveCity(value:string|null,tenantId?:string):Promise<{id:string;canonicalName:string}|null>; resolveCompany(value:string|null,tenantId?:string):Promise<{id:string;canonicalName:string}|null>; resolveProduct(value:string|null,tenantId?:string):Promise<{id:string;canonicalName:string}|null>; }
export interface MalwareScanner { scan(input:Uint8Array):Promise<{clean:boolean;signature?:string}>; }
export interface AuditSink { write(event:{tenantId:string;actor:string;action:string;outcome:'ALLOW'|'DENY'|'ERROR';target?:string;metadata?:Record<string,unknown>}):Promise<void>; }
export type CollectorPurpose='BUSINESS'|'FREIGHT_INTELLIGENCE';
export type ResolvedCollector={collectorId:string;tenantId:string;provider:string;account:string;purpose:CollectorPurpose;status:'HEALTHY'|'DEGRADED'|'DOWN'|'DISABLED';webhookSecretHash?:string};
export interface CollectorResolver { resolve(collectorId:string):Promise<ResolvedCollector|null>; recordSuccess?(collectorId:string,latencyMs:number,lastMessage?:Date):Promise<void>; recordFailure?(collectorId:string,latencyMs:number,error:string):Promise<void>; }
export interface QuarantineStore { put(message:RawMessage,expiresAt:Date):Promise<void>; mark(message:RawMessage,disposition:'PROMOTED'|'DISCARDED'|'REJECTED'):Promise<void>; }
export type DownloadedMedia={bytes:Uint8Array;mimeType:string;fileName?:string};
export interface ContentProcessor { extract(input:DownloadedMedia&{messageType:RawMessage['messageType']}):Promise<string>; }
export type BusinessToolCall={name:string;input:Record<string,unknown>};
export type BusinessToolResult={name:string;ok:boolean;output?:unknown;error?:string};
export type BusinessPlan={role:'FRONT_DESK'|'SALES'|'QUOTE'|'CRM'|'SCHEDULING'|'SUPPORT'|'HUMAN_HANDOFF';reply:string;toolCalls:BusinessToolCall[];handoff:boolean;handoffReason:string|null};
export interface BusinessDecisionModel {
  plan(input:{message:string;tools:Array<{name:string;description:string;risk:string;inputSchema?:Record<string,unknown>}>;suspicious:boolean}):Promise<BusinessPlan>;
  finalize?(input:{message:string;plan:BusinessPlan;toolResults:BusinessToolResult[]}):Promise<{reply:string;handoff:boolean;handoffReason:string|null}>;
}
export type ConversationState='OPEN'|'WAITING_HUMAN'|'HUMAN'|'CLOSED';
export interface ConversationStore { ensure(message:RawMessage):Promise<{conversationId:string;state:ConversationState}>; getRouting(tenantId:string,conversationId:string):Promise<{provider:string;routingAddress:string}|null>; }
export type BusinessRunResult={reply:string;handoff:boolean;handoffReason:string|null};
export type BusinessRunClaim=
  | {state:'NEW';runId:string}
  | {state:'PROCESSING';runId:string}
  | {state:'PENDING_SEND';runId:string;result:BusinessRunResult}
  | {state:'SENDING';runId:string}
  | {state:'SENT';runId:string;result:BusinessRunResult;replyMessageId?:string}
  | {state:'FAILED';runId:string}
  | {state:'DELIVERY_UNCERTAIN';runId:string};
export interface BusinessRunStore {
  claim(message:RawMessage,conversationId:string):Promise<BusinessRunClaim>;
  completeProcessing(tenantId:string,runId:string,result:BusinessRunResult):Promise<void>;
  beginSend(tenantId:string,runId:string):Promise<void>;
  markNoSendCompleted(tenantId:string,runId:string):Promise<void>;
  markSent(tenantId:string,runId:string,replyMessageId?:string):Promise<void>;
  markSendRetryable(tenantId:string,runId:string,error:string):Promise<void>;
  markDeliveryUncertain(tenantId:string,runId:string,error:string):Promise<void>;
  markFailed(tenantId:string,runId:string,error:string):Promise<void>;
}
export interface BusinessMessageHandler { handle(message:RawMessage,provider:WhatsAppProvider):Promise<{reply:string;handoff:boolean;replyMessageId?:string;conversationId?:string}>; }
