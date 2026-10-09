'use strict';

const path = require('path');

const serverRoot = '/usr/src/wpp-server';
const config = require(path.join(serverRoot, 'dist', 'config.js')).default;
const { initServer } = require(path.join(serverRoot, 'dist', 'index.js'));

const webhookUrl = process.env.WEBHOOK_URL;
if (!webhookUrl || !webhookUrl.startsWith('http://bridge:8081/')) {
  throw new Error('WEBHOOK_URL must point to the private bridge service');
}

const secretKey = process.env.SECRET_KEY;
if (!secretKey || secretKey.length < 32 || secretKey === 'THISISMYSECURETOKEN') {
  throw new Error('SECRET_KEY must be a non-default secret of at least 32 characters');
}

const port = Number(process.env.PORT || '21465');
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT is invalid');
}

process.env.MANAGER_ENABLED = 'false';

// Replace permissive upstream browser defaults rather than merging with them.
// Chromium still needs no-sandbox in the upstream container, but certificate
// validation and same-origin protections remain enabled.
config.createOptions.browserArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-sync',
  '--mute-audio',
  '--no-first-run',
];

config.webhook.autoDownload = false;
config.webhook.uploadS3 = false;
config.webhook.readMessage = false;
config.websocket.autoDownload = false;
config.websocket.uploadS3 = false;

initServer({
  host: process.env.HOST || 'http://127.0.0.1',
  port,
  secretKey,
  startAllSession: true,
  tokenStoreType: 'file',
  customUserDataDir: '/data/userDataDir/',
  webhook: {
    url: webhookUrl,
    autoDownload: false,
    uploadS3: false,
    readMessage: false,
    allUnreadOnStart: false,
    listenAcks: false,
    onPresenceChanged: false,
    onParticipantsChanged: false,
    onReactionMessage: false,
    onPollResponse: false,
    onRevokedMessage: false,
    onLabelUpdated: false,
    onSelfMessage: false,
    ignore: ['status@broadcast'],
  },
  websocket: {
    autoDownload: false,
    uploadS3: false,
  },
  archive: {
    enable: false,
  },
  log: {
    level: process.env.WPP_LOG_LEVEL || 'warn',
    logger: ['console'],
  },
});
