'use strict';

const path = require('path');

const serverRoot = '/usr/src/wpp-server';
const { initServer } = require(path.join(serverRoot, 'dist', 'index.js'));

const webhookUrl = process.env.WEBHOOK_URL;
if (!webhookUrl || !webhookUrl.startsWith('http://bridge:8081/')) {
  throw new Error('WEBHOOK_URL must point to the private bridge service');
}

const port = Number(process.env.PORT || '21465');
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PORT is invalid');
}

process.env.MANAGER_ENABLED = 'false';

initServer({
  host: process.env.HOST || 'http://127.0.0.1',
  port,
  secretKey: process.env.SECRET_KEY,
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
