// Copy of the lanUrl logic from PolyPoly (apps/server/src/index.ts).
// Only change: the port is a parameter instead of a module constant.
import { networkInterfaces } from 'node:os';

const SKIPPED_INTERFACE_NAME = /tailscale|vethernet|virtualbox|docker|wsl/i;
const SKIPPED_ADDRESS_PREFIX = ['192.168.56.']; // VirtualBox host-only default range
const WIFI_INTERFACE_NAME = /wi-?fi|wlan/i;

/** The LAN IPv4 address a phone on the same network can reach, or null when the machine has none. */
export function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (SKIPPED_INTERFACE_NAME.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (SKIPPED_ADDRESS_PREFIX.some((p) => addr.address.startsWith(p))) continue;
      candidates.push({ name, ip: addr.address });
    }
  }
  // Prefer the actual wifi adapter, since that's what a phone on the same
  // network will be reachable through — other private ranges tend to belong
  // to VPNs or virtual adapters that only this machine can see.
  const wifi = candidates.find((c) => WIFI_INTERFACE_NAME.test(c.name));
  const home = candidates.find((c) => c.ip.startsWith('192.168.'));
  return wifi?.ip ?? home?.ip ?? candidates[0]?.ip ?? null;
}

/** `http://<lan ip>:<port>`, or null when no LAN address is found. */
export function lanOrigin(port) {
  const ip = lanAddress();
  return ip ? `http://${ip}:${port}` : null;
}

export function lanUrl(port) {
  return lanOrigin(port) ?? `http://localhost:${port}`;
}
