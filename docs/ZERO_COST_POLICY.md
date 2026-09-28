# Zero-Cost Policy

## Regra canônica

A configuração oficial do WhatsApp AI deve operar sem cobrança obrigatória de API, SaaS, cloud ou runner hospedado.

`ZERO_COST_MODE=true` é o default e deve permanecer habilitado na candidata oficial.

O software não consegue eliminar custos físicos do ambiente do proprietário, como computador/servidor, armazenamento, energia e conectividade.

## Permitido no caminho canônico

- PostgreSQL self-hosted;
- WPPConnect Server self-hosted para cenários autorizados de WhatsApp Web;
- Ollama self-hosted;
- Qwen3-VL local;
- whisper.cpp local;
- ClamAV, FFmpeg e Poppler locais;
- pg-boss sobre o mesmo PostgreSQL;
- exportação AgroLog local em NDJSON;
- autenticação local de operador/RBAC sem IdP obrigatório;
- Release Gate em máquina/runner self-hosted;
- Semgrep CE, Gitleaks e Trivy locais.

## Bloqueado no zero-cost mode

- credenciais de envio Meta Cloud;
- endpoint público/externo de IA;
- endpoint público/externo de transcrição;
- AgroLog Gateway externo;
- API comercial paga incorporada como requisito;
- CI hospedado como requisito de release;
- observabilidade SaaS obrigatória;
- IdP comercial obrigatório para a operação interna.

A validação de configuração deve falhar antes da inicialização caso um endpoint proibido seja configurado.

## Integrações opcionais

Meta Cloud e AgroLog HTTP podem continuar existindo como adapters, mas somente fora do modo zero-cost e mediante decisão explícita. Eles não fazem parte do gate canônico.

## Regra para novas ferramentas

Uma nova dependência só entra se:

1. resolver lacuna concreta;
2. não duplicar capacidade já suficiente;
3. possuir licença compatível;
4. não criar cobrança obrigatória;
5. passar todo o Release Acceptance Matrix;
6. substituir a ferramenta anterior quando não houver razão objetiva para manter ambas.
