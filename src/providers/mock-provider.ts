import { randomUUID } from 'node:crypto';
import type { WhatsAppProvider } from '../domain/ports.js';
import { RawMessageSchema, type ProviderCapabilities } from '../domain/schemas.js';
import { sha256 } from '../security/crypto.js';

export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly id = 'mock';
  readonly capabilities: ProviderCapabilities = { receive:true,send:true,media:true,templates:true,managedGroups:true,existingGroups:true,historySync:true,receipts:true,reactions:true };
  readonly sent:Array<{to:string;text:string}>=[];
  async sendText(input:{tenantId:string;to:string;text:string}){this.sent.push({to:input.to,text:input.text});return{messageId:`mock-${randomUUID()}`};}
  async normalizeInbound(input:unknown,context:{tenantId:string;collectorId:string}){const row=input as Record<string,unknown>;const text=String(row.text??'');const now=row.timestamp?new Date(String(row.timestamp)):new Date();const messageId=String(row.messageId??randomUUID());return[RawMessageSchema.parse({eventId:randomUUID(),tenantId:context.tenantId,provider:this.id,collectorId:context.collectorId,accountId:String(row.accountId??'mock-account'),messageId,chatId:String(row.chatId??'mock-chat'),groupId:row.groupId?String(row.groupId):null,occurredAt:now,receivedAt:new Date(),senderReference:String(row.senderReference??'mock-sender'),routingAddress:String(row.routingAddress??row.senderReference??'5511999999999'),messageType:row.messageType??'text',text,attachmentReference:row.attachmentReference?String(row.attachmentReference):null,replyContext:null,contentHash:sha256(text||messageId),sourcePayload:row,schemaVersion:1})];}
  async downloadMedia(reference:string){return{bytes:new TextEncoder().encode(reference),mimeType:'text/plain',fileName:'mock.txt'};}
  async health(){return{ok:true,details:{mode:'test'}};}
}
