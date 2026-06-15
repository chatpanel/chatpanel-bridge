// Background auto-start for the ChatPanel Bridge.
//
// So non-technical users never touch a terminal: download the app, run it once
// with --install, and it launches at login and stays running.
//
//   chatpanel-bridge --install     register login auto-start + start now
//   chatpanel-bridge --uninstall   remove it
//   chatpanel-bridge --status      is it registered?
//
// macOS → LaunchAgent · Windows → Scheduled Task (ONLOGON) · Linux → systemd user.

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const LABEL = 'net.chatpanel.bridge';
const DISPLAY = 'ChatPanel Bridge';

// The command that launches THIS bridge. A compiled single-file binary launches
// itself (no args); running under node/bun launches the interpreter + this script.
export function resolveLaunch() {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  const underInterpreter = base.startsWith('node') || base.startsWith('bun');
  if (underInterpreter && process.argv[1]) {
    return { program: exe, args: [path.resolve(process.argv[1])] };
  }
  return { program: exe, args: [] };
}

function logPaths() {
  const dir = path.join(os.homedir(), '.chatpanel');
  mkdirSync(dir, { recursive: true });
  return { out: path.join(dir, 'bridge.log'), err: path.join(dir, 'bridge.err.log') };
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

// ---------------------------------------------------------------- macOS
const macPlist = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function macInstall() {
  const { program, args } = resolveLaunch();
  const { out, err } = logPaths();
  const progArgs = [program, ...args].map((a) => `      <string>${a}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${progArgs}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${out}</string>
    <key>StandardErrorPath</key><string>${err}</string>
  </dict>
</plist>
`;
  const p = macPlist();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, plist);
  run('launchctl', ['unload', p]); // ignore if not loaded
  const r = run('launchctl', ['load', '-w', p]);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'launchctl load failed');
}
function macUninstall() {
  const p = macPlist();
  run('launchctl', ['unload', '-w', p]);
  if (existsSync(p)) rmSync(p);
}
function macStatus() {
  return (run('launchctl', ['list']).stdout || '').includes(LABEL);
}

// ---------------------------------------------------------------- Windows
const WIN_TASK = 'ChatPanelBridge';

function winInstall() {
  const { program, args } = resolveLaunch();
  const tr = [`"${program}"`, ...args.map((a) => `"${a}"`)].join(' ');
  const r = run('schtasks', ['/Create', '/TN', WIN_TASK, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'schtasks create failed');
  run('schtasks', ['/Run', '/TN', WIN_TASK]); // start now
}
function winUninstall() {
  run('schtasks', ['/Delete', '/TN', WIN_TASK, '/F']);
}
function winStatus() {
  return run('schtasks', ['/Query', '/TN', WIN_TASK]).status === 0;
}

// ---------------------------------------------------------------- Linux (systemd user)
const linUnit = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'chatpanel-bridge.service');

function linInstall() {
  const { program, args } = resolveLaunch();
  const exec = [program, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const unit = `[Unit]
Description=${DISPLAY}
After=network.target

[Service]
ExecStart=${exec}
Restart=on-failure

[Install]
WantedBy=default.target
`;
  const p = linUnit();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  const r = run('systemctl', ['--user', 'enable', '--now', 'chatpanel-bridge']);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'systemctl enable failed');
}
function linUninstall() {
  run('systemctl', ['--user', 'disable', '--now', 'chatpanel-bridge']);
  const p = linUnit();
  if (existsSync(p)) rmSync(p);
}
function linStatus() {
  return (run('systemctl', ['--user', 'is-enabled', 'chatpanel-bridge']).stdout || '').trim() === 'enabled';
}

// ---------------------------------------------------------------- dispatch
function byPlatform(mac, win, lin) {
  if (process.platform === 'darwin') return mac();
  if (process.platform === 'win32') return win();
  if (process.platform === 'linux') return lin();
  throw new Error(`Auto-start isn't supported on ${process.platform} yet — run the bridge directly.`);
}

export function installService() {
  return byPlatform(macInstall, winInstall, linInstall);
}
export function uninstallService() {
  return byPlatform(macUninstall, winUninstall, linUninstall);
}
export function serviceStatus() {
  return byPlatform(macStatus, winStatus, linStatus);
}
