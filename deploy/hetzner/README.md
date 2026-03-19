# Deploy na Hetzner

Este guia assume uma arquitetura simples:

- 1 VPS Hetzner Cloud
- Redis local na mesma VPS
- `worker` e `whatsapp` gerenciados por `systemd`
- Ubuntu 24.04

## Limite importante do projeto atual

O bot so absorve rajadas via fila no fluxo de WhatsApp quando `RECEIPT_ASYNC_WHATSAPP_MODE=true`.

No estado atual do codigo:

- `RECEIPT_ASYNC_WHATSAPP_MODE=false`: melhor comportamento funcional no grupo, mas o WhatsApp processa a imagem no proprio processo
- `RECEIPT_ASYNC_WHATSAPP_MODE=true`: aguenta melhor rajadas, mas ainda nao responde no grupo apos o worker concluir

Se sua prioridade imediata for robustez em picos, prefira `true`.
Se sua prioridade for resposta operacional no grupo, prefira `false` e aceite menos folga em rajadas.

## Recomendacao de servidor

- Localizacao: `ASH` se voce quer menor latencia para o Brasil
- Tipo: `Dedicated / General Purpose`
- Plano recomendado: `CCX23` (4 vCPU, 16 GB RAM)
- Plano minimo aceitavel: `CCX13` (2 vCPU, 8 GB RAM)
- Image: `Ubuntu 24.04`
- Backups: `enabled`
- IPv4: `enabled`
- IPv6: `enabled`

## Estrutura de diretorios assumida

- repositorio: `/opt/kptransportes`
- app do bot: `/opt/kptransportes/apps/receipt-whatsapp-bot`
- usuario do app: `kpbot`
- config Redis: `/etc/redis/receipt-whatsapp-bot.conf`

## Passo a passo no painel da Hetzner

### 1. Criar a VPS

No console da Hetzner:

1. Entre no projeto.
2. Va em `Firewalls` > `Create Firewall`.
3. Crie um firewall chamado `kptransportes-prod`.
4. Adicione regra inbound `TCP 22` liberada apenas para o seu IP atual.
5. Nao abra `6379`.
6. Se voce nao pretende expor a API HTTP agora, nao abra `80`, `443` nem `3390`.
7. Va em `Servers` > `Add server`.
8. Escolha `Location` = `ASH`.
9. Escolha `Image` = `Ubuntu 24.04`.
10. Escolha `Type` = `Dedicated General Purpose`, preferencialmente `CCX23`.
11. Em `Networking`, mantenha `IPv4 + IPv6`.
12. Em `SSH key`, selecione sua chave.
13. Em `Firewalls`, aplique `kptransportes-prod`.
14. Em `Backups`, habilite backups diarios.
15. Dê um nome como `kptransportes-bot-01`.
16. Clique em `Create & Buy now`.

### 2. Opcional: criar rede privada

Se voce futuramente separar Redis em outra VPS:

1. Va em `Networks` > `Create network`.
2. Use algo como `10.10.0.0/16`.
3. Depois va na rede criada e em `Attach Resource`.
4. Anexe os servidores da aplicacao.

## Comandos de instalacao na VPS

Conecte via SSH e rode:

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y git curl ca-certificates gnupg redis-server nodejs npm
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
chmod a+r /etc/apt/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
sudo apt-get update
sudo apt-get install -y google-chrome-stable
sudo useradd --system --create-home --shell /bin/bash kpbot || true
sudo mkdir -p /opt/kptransportes
sudo chown -R kpbot:kpbot /opt/kptransportes
sudo mkdir -p /var/lib/redis-receipt-whatsapp-bot
sudo chown -R redis:redis /var/lib/redis-receipt-whatsapp-bot
```

Clone o projeto:

```bash
sudo -u kpbot git clone <URL_DO_REPOSITORIO> /opt/kptransportes
cd /opt/kptransportes/apps/receipt-whatsapp-bot
sudo -u kpbot npm ci
```

Se o `node -v` vier abaixo de `18`, atualize o Node antes de rodar `npm ci`.

## `.env` recomendado para producao

Edite `/opt/kptransportes/apps/receipt-whatsapp-bot/.env`:

```dotenv
BOT_ENV=production
LOG_LEVEL=info

RECEIPT_JOB_QUEUE_DRIVER=bullmq
RECEIPT_PROCESSING_STATE_REPOSITORY_DRIVER=redis
RECEIPT_REDIS_URL=redis://127.0.0.1:6379
RECEIPT_QUEUE_CONCURRENCY=2
RECEIPT_QUEUE_MAX_ATTEMPTS=3
RECEIPT_QUEUE_BACKOFF_MS=5000

RECEIPT_ASSET_STORAGE_DRIVER=local
RECEIPT_BACKEND_API_BASE_URL=https://SEU-BACKEND.up.railway.app
RECEIPT_BACKEND_API_TOKEN=SEU_TOKEN_TECNICO
RECEIPT_BACKEND_SYNC_MODE=status_only
RECEIPT_INVOICE_LOOKUP_MODE=backend_api
RECEIPT_PROVIDER_GOOGLE_VISION_ENABLED=true
RECEIPT_PROVIDER_GOOGLE_VISION_API_KEY=SUA_CHAVE_GOOGLE_VISION
RECEIPT_LEGACY_FALLBACK_ENABLED=false

RECEIPT_ASYNC_WHATSAPP_MODE=true

WHATSAPP_HEADLESS=true
WHATSAPP_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
WHATSAPP_ALLOWED_GROUP_IDS=SEU_GRUPO@g.us
WHATSAPP_REPLY_ENABLED=false
WHATSAPP_REPLY_ON_OPERATIONAL_FAILURE=false
WHATSAPP_COMMANDS_ENABLED=false
```

No backend do Railway, configure o mesmo token em `RECEIPT_BOT_SERVICE_TOKEN`.
Se quiser evitar enviar o escopo da empresa em cada chamada, configure tambem `RECEIPT_BOT_DEFAULT_COMPANY_CODE`.
Se a prioridade for throughput e latencia previsivel, mantenha `RECEIPT_LEGACY_FALLBACK_ENABLED=false` para evitar cair no OCR legado pesado quando o provider principal falhar.

## Configurar Redis

Copie o arquivo `deploy/redis/receipt-whatsapp-bot.conf` para `/etc/redis/receipt-whatsapp-bot.conf`.

Depois:

```bash
sudo cp /opt/kptransportes/apps/receipt-whatsapp-bot/deploy/redis/receipt-whatsapp-bot.conf /etc/redis/receipt-whatsapp-bot.conf
sudo chown root:root /etc/redis/receipt-whatsapp-bot.conf
sudo systemctl disable --now redis-server.service
sudo cp /opt/kptransportes/apps/receipt-whatsapp-bot/deploy/systemd/receipt-whatsapp-bot-redis.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now receipt-whatsapp-bot-redis.service
sudo systemctl status receipt-whatsapp-bot-redis.service
redis-cli -p 6379 ping
```

O retorno esperado do ultimo comando e:

```text
PONG
```

## Configurar `worker` e `whatsapp`

Copie os arquivos de service:

```bash
sudo cp /opt/kptransportes/apps/receipt-whatsapp-bot/deploy/systemd/receipt-whatsapp-bot-worker.service /etc/systemd/system/
sudo cp /opt/kptransportes/apps/receipt-whatsapp-bot/deploy/systemd/receipt-whatsapp-bot-whatsapp.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## Primeira autenticacao do WhatsApp

Na primeira vez, faca a autenticacao manualmente para ler o QR no terminal:

```bash
cd /opt/kptransportes/apps/receipt-whatsapp-bot
sudo -u kpbot /usr/bin/node src/whatsapp.js
```

Escaneie o QR com o numero que participa do grupo. Depois interrompa com `Ctrl+C`.

Agora habilite os servicos:

```bash
sudo systemctl enable --now receipt-whatsapp-bot-worker.service
sudo systemctl enable --now receipt-whatsapp-bot-whatsapp.service
```

## Comandos uteis

Status dos servicos:

```bash
sudo systemctl status receipt-whatsapp-bot-redis.service
sudo systemctl status receipt-whatsapp-bot-worker.service
sudo systemctl status receipt-whatsapp-bot-whatsapp.service
```

Logs em tempo real:

```bash
sudo journalctl -u receipt-whatsapp-bot-redis.service -f
sudo journalctl -u receipt-whatsapp-bot-worker.service -f
sudo journalctl -u receipt-whatsapp-bot-whatsapp.service -f
```

Reiniciar depois de alterar `.env`:

```bash
sudo systemctl restart receipt-whatsapp-bot-worker.service
sudo systemctl restart receipt-whatsapp-bot-whatsapp.service
```

## Como eu recomendo operar no inicio

- 1 VPS apenas
- Redis local
- `CCX23`
- backups diarios ativados
- firewall da Hetzner so com `22/tcp` aberto
- `RECEIPT_QUEUE_CONCURRENCY=2`
- acompanhar CPU e RAM por alguns dias antes de aumentar concorrencia

## Sinais de que voce precisa subir o plano ou mudar o modo

- backlog crescente no worker
- CPU perto de 100% por periodos longos
- uso de RAM acima de 75% com frequencia
- Chromium morrendo ou reiniciando
- mensagens demorando demais para serem tratadas
