import net from 'node:net';
import type { MalwareScanner } from '../domain/ports.js';

export class ClamAvScanner implements MalwareScanner {
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 10_000) {}

  async ping(): Promise<boolean> {
    return await new Promise((resolve) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = '';
      const finish = (ok: boolean) => { if (!socket.destroyed) socket.destroy(); resolve(ok); };
      const timer = setTimeout(() => finish(false), Math.min(this.timeoutMs, 3000));
      socket.on('connect', () => socket.write(Buffer.from('zPING\0')));
      socket.on('data', (data) => { response += data.toString('utf8'); if (response.includes('PONG')) { clearTimeout(timer); finish(true); } });
      socket.on('error', () => { clearTimeout(timer); finish(false); });
      socket.on('close', () => { clearTimeout(timer); if (!response.includes('PONG')) resolve(false); });
    });
  }

  async scan(input: Uint8Array): Promise<{ clean: boolean; signature?: string }> {
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let response = '';
      const timer = setTimeout(() => socket.destroy(new Error('clamav_timeout')), this.timeoutMs);
      socket.on('connect', () => {
        socket.write(Buffer.from('zINSTREAM\0'));
        for (let offset = 0; offset < input.byteLength; offset += 8192) {
          const chunk = Buffer.from(input.slice(offset, Math.min(offset + 8192, input.byteLength)));
          const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length); socket.write(size); socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', (data) => { response += data.toString('utf8'); });
      socket.on('error', (error) => { clearTimeout(timer); reject(error); });
      socket.on('close', () => {
        clearTimeout(timer);
        if (response.includes(' OK')) return resolve({ clean: true });
        const match = response.match(/: (.+) FOUND/);
        if (match) return resolve({ clean: false, signature: match[1] });
        reject(new Error(`clamav_invalid_response:${response.trim()}`));
      });
    });
  }
}

export class RejectingScanner implements MalwareScanner {
  async scan(): Promise<{ clean: boolean; signature?: string }> { throw new Error('malware_scanner_unavailable'); }
}
