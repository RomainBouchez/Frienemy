import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from './src/app.js';
import { lanOrigin, lanUrl } from './src/lan.js';
import { EDITION } from './src/edition.js';

const require = createRequire(import.meta.url);
const qrcode = require('qrcode-generator');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const ADMIN_PIN = process.env.ADMIN_PIN || undefined;

/**
 * QR code of `text` as terminal lines (Unicode half blocks). Light modules are drawn as blocks and dark
 * modules as blanks, so the code reads dark-on-light in a dark terminal (the usual default), quiet zone included.
 */
function terminalQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const size = count + margin * 2;
  // A module outside the code (quiet zone) is light.
  const light = (row, col) => {
    const inside = row >= margin && col >= margin && row < size - margin && col < size - margin;
    return !inside || !qr.isDark(row - margin, col - margin);
  };
  const lines = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col += 1) {
      const top = light(row, col);
      const bottom = row + 1 < size ? light(row + 1, col) : true;
      if (top && bottom) line += '█';
      else if (top) line += '▀';
      else if (bottom) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const server = await startServer({ port: PORT, dataDir: DATA_DIR, adminPin: ADMIN_PIN, accessOpen: EDITION.accessOpenAtStart });
console.log(`${EDITION.name} : ${lanUrl(server.port)}`);
// Scanned from a phone on the same network: only when the machine has a LAN address (localhost is useless to a phone).
const joinUrl = lanOrigin(server.port);
if (joinUrl) console.log(`Scanne pour rejoindre (${joinUrl}) :\n${terminalQr(joinUrl)}`);
// Only a generated PIN is printed; a PIN supplied through ADMIN_PIN is never logged.
if (server.adminPinGenerated) console.log(`PIN admin : ${server.adminPin}`);
