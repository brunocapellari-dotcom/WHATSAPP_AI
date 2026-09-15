# WhatsApp AI

Plataforma própria de inteligência e automação sobre WhatsApp, com dois domínios no mesmo núcleo seguro:

- **WhatsApp Business AI** — atendimento, vendas, orçamento, pedidos, agenda, CRM, follow-up e handoff humano por ferramentas estruturadas.
- **WhatsApp Intelligence** — coleta autorizada e tratamento de mensagens relevantes; a aplicação inicial é **WhatsApp Freight Intelligence**, que produz eventos estruturados para o AgroLog MT.

## Princípios

- conteúdo de WhatsApp é sempre **dado não confiável**;
- LLM interpreta, mas ações são executadas apenas por ferramentas estruturadas e políticas determinísticas;
- multi-tenancy por `tenant_id` + PostgreSQL RLS;
- `WhatsAppProvider` desacopla o domínio dos conectores;
- payload original fica em quarentena criptografada e temporária; o armazenamento governado persiste somente o necessário;
- `FreightObservation` preserva cada ocorrência; `FreightEvent` consolida reposts sem perder provenance;
- verdade é classificada por campo: `OBSERVADO`, `INFERIDO`, `ESTIMADO`, `CONFIRMADO_EXTERNAMENTE`;
- integração com AgroLog usa Transactional Outbox e idempotência, nunca escrita direta nas tabelas analíticas.

A implementação completa é desenvolvida e validada em branch antes de ser incorporada à `main`.
