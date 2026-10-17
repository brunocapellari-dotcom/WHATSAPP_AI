# WhatsApp AI — proposta de servidor 24h, sem cobrança não autorizada

**Decisão de arquitetura (15/10/2026):** servidor 24h como destino final.
O WhatsApp AI é autônomo e NÃO depende do NIVON ou AgroLog para gerar e
distribuir relatórios. Não migrar para execução exclusiva em Android.

## Fatos verificados

1. A imagem WPPConnect fixada no projeto
   `wppconnect/wppconnect-server:sha-c192518` é **linux/amd64** apenas
   (Docker Hub: https://hub.docker.com/r/wppconnect/wppconnect-server/tags).
2. Oracle Cloud Always Free Ampere A1 é **ARM64**; conforme documentação
   de outubro/2026 seu limite gratuito é de até 2 OCPU / 12 GB RAM para
   contas elegíveis, limitado por estoque da região e pelas condições de
   recuperação de instâncias ociosas.
3. Google Cloud e2-micro Always Free tem memória muito pequena para
   assumir Chromium + PostgreSQL + geração de relatórios sem teste.
4. **Não é correto dizer que o compose original funciona diretamente no
   Oracle A1.** Este diretório fornece uma rota de build nativo ARM64
   CANDIDATA, sujeita a homologação. Nenhuma máquina foi criada.

## Candidato de custo zero: Oracle Cloud ARM64

O upstream WPPConnect tem Dockerfile fonte público em
https://github.com/wppconnect-team/wppconnect-server/blob/c19251895e03922d302bffada6b5a4f8383fe5ae/Dockerfile .
O script `build-wppconnect-arm64.sh` usa exatamente o commit upstream
`c19251895e03922d302bffada6b5a4f8383fe5ae` e faz build nativo,
instalando o Chromium arm64 via Alpine. **Build ainda não executado**.

Executar o build SOMENTE em máquina ARM64 já autorizada para testes:

```bash
bash deploy/server/build-wppconnect-arm64.sh
```

Usar `deploy/server/docker-compose.arm64.yml` como override da imagem do
WPPConnect, em conjunto com o compose base de `deploy/local` depois
de testar o build, QR e ingestão. Todos os serviços deverão permanecer
vinculados a localhost ou redes internas Docker. Não publicar as portas
21465, 8080, 5432 e 8081 na Internet.

**Não rodar o instalador local sem revisão no servidor:** paths de scripts,
rede, limites e backup precisam ser adaptados ao ambiente remoto. Usar
`docker compose config` e testes de health/readiness antes de qualquer
sessão autorizada.

## Homologação obrigatória de go-live

- Build e execução real linux/arm64 da imagem, incluindo sessão WPPConnect;
- pareamento do número autorizado por canal privado/SSH, sem exposição
  pública do QR e sem enviar tokens para o Git;
- prova de coleta de pelo menos duas publicações reais de **Canais** seguidos,
  identificadas como canais (não grupos), verificando permissões;
- prova de envio autorizado de pelo menos duas mensagens e dos anexos
  PDF/XLSX ao destinatário definido, sem duplicações;
- pipeline de fretes multi-linhas e relatórios completo e simplificado MT;
- execução bem-sucedida de teste unitário, integração, restore drill, e
  retomada após interrupção de serviço;
- reinício automático, limites, alertas de falha, monitoramento do disco,
  criptografia, backup externo cifrado com restauração real;
- resolução de falhas de CI. O PR #18 ainda NÃO está aprovado.

O servidor resolve disponibilidade de computação, **não garante** que
WhatsApp Web forneça leitura completa dos canais nem envio automático
compatível com os termos da plataforma. Se a integração não passar pelos
testes, declarar bloqueio e não forçar go-live.

## Segurança e custo

- Nada de tokens, QR ou arquivo .env no Git, chats ou logs abertos.
- Acesso administrativo apenas via SSH com chave; nenhuma API WPPConnect
  e nenhum banco de dados expostos publicamente.
- Sem habilitar serviços pagos, billing upgrade, IPs cobrados, backups
  pagos, tráfego excedente ou add-ons. Confirmar limites da conta.
- Instâncias Always Free da Oracle podem ser recuperadas por ociosidade,
  portanto plano de backup externo e recuperação é obrigatório.
- Se ARM64 não for homologado, avaliar VPS **AMD64** com orçamento
  explícito do usuário antes de contratar. Não fingir que o plano
  gratuito cumpre todos os requisitos.
