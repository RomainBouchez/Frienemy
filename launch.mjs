// Frienemy launcher (npm start): installs the dependencies on the first run, then starts server.js.
// Works on Windows, macOS and Linux: npm is run as npm.cmd on Windows, through a shell.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const [major] = process.versions.node.split('.').map(Number);

if (major < 22) {
  console.error(`Frienemy demande Node.js 22 ou plus (tu as la version ${process.versions.node}).`);
  process.exit(1);
}

// Express is the marker: a node_modules folder without it (interrupted install) is installed again.
if (!fs.existsSync(path.join(root, 'node_modules', 'express'))) {
  console.log('Premier lancement : installation des dépendances, ça peut prendre une minute…');
  const npm = isWindows ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--no-fund', '--no-audit'], {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
  });
  if (result.status !== 0) {
    console.error("L'installation a échoué. Vérifie ta connexion internet, puis relance npm start.");
    process.exit(result.status ?? 1);
  }
}

const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
