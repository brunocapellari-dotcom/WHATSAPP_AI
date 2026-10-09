# WhatsApp AI — produção local zero-cost

Este é o alvo oficial de GO-LIVE sem custo recorrente obrigatório de cloud.

## Custo

O stack não exige Cloud Run, Cloud SQL, Cloud Armor, Load Balancer, domínio, API paga ou banco gerenciado.

Ele usa somente:

- computador/servidor já existente;
- Docker + Docker Compose;
- PostgreSQL local;
- WPPConnect Server;
- armazenamento local;
- GitHub apenas para código/CI.

Energia, internet e hardware existentes continuam sendo custos físicos do ambiente, mas não há serviço cloud pago obrigatório.

## Arquitetura

```
WhatsApp dedicado
  -> WPPConnect local
  -> bridge privado
  -> WhatsApp AI ingress local
  -> PostgreSQL local
  -> outbox
  -> AgroLog local (quando habilitado)
```

PostgreSQL não publica porta. Ingress e WPPConnect só publicam portas em `127.0.0.1`. Bridge não publica porta no host.

## 1. Preparar

Na pasta `deploy/local`:

```bash
./setup.sh
```

O script gera `.env` com secrets aleatórios e permissão `0600`. O arquivo nunca deve ser enviado ao Git, chat, e-mail ou screenshot.

## 2. Subir

```bash
./start.sh
```

Isso sobe PostgreSQL, migrations, ingress, bridge e WPPConnect.

## 3. Parear WhatsApp

```bash
./pair.sh
```

Abra somente o arquivo local `pairing-qr.png` e escaneie com um número dedicado e autorizado.

Não use o número pessoal principal para automação baseada em WhatsApp Web.

## 4. AgroLog local

Por padrão a entrega ao AgroLog fica desligada para não consumir tentativas enquanto o AgroLog não estiver disponível.

Quando o receiver local do AgroLog estiver rodando:

```bash
./enable-agrolog-delivery.sh http://host.docker.internal:8000/v1/freight/events
```

O valor `AGROLOG_SHARED_SECRET` em `deploy/local/.env` deve ser o mesmo usado pelo receiver local do AgroLog.

## 5. Status

```bash
./status.sh
```

## 6. Backup

```bash
./backup.sh
```

Backups ficam em `deploy/local/backups/`, fora do Git, com SHA-256 e retenção local de 14 dias.

## 7. Restore drill

```bash
./restore-drill.sh
```

O restore é feito em um banco temporário e removido ao final. O banco principal não é sobrescrito.

## Segurança

- raw events continuam criptografados com AES-GCM;
- RLS por tenant continua ativo;
- WPPConnect e ingress ficam restritos ao localhost;
- banco não publica porta;
- bridge e banco usam redes Docker isoladas;
- HMAC continua obrigatório entre bridge e ingress;
- HTTP local só é permitido para hostnames internos explicitamente allowlisted;
- mídia permanece metadata-only até existir quarentena + malware scan;
- secrets ficam em arquivo local `0600`, nunca em Git.

## Observação operacional

WPPConnect é automação baseada em WhatsApp Web. Ela evita tarifa de API oficial, mas não oferece a mesma garantia contratual de uma integração oficial da Meta. Use um número dedicado ao projeto.
