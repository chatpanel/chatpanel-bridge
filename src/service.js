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
import { spawn, spawnSync } from 'node:child_process';

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
// Per-user auto-start via the HKCU Run key — works without admin (a scheduled
// task can be blocked by policy: "Access is denied"). A tiny .vbs launcher runs
// the bridge with NO console window.
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_RUN_NAME = 'ChatPanelBridge';
// A user-writable location for the launcher. NOT next to the program — under
// `npm i -g` the program is node.exe, whose dir is protected (EPERM).
const winVbs = () => path.join(os.homedir(), '.chatpanel', 'launch.vbs');

function winInstall() {
  const { program, args } = resolveLaunch();
  // VBS quoting: "" is a literal quote inside a string. Run(cmd, 0=hidden, False).
  const parts = [program, ...args].map((p) => `""${p}""`).join(' ');
  const vbs = winVbs();
  mkdirSync(path.dirname(vbs), { recursive: true });
  writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${parts}", 0, False\r\n`);
  const r = run('reg', ['add', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f']);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'reg add failed');
  run('wscript.exe', [vbs]); // start now, hidden
}
function winUninstall() {
  run('reg', ['delete', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/f']);
  run('taskkill', ['/IM', 'chatpanel-bridge.exe', '/F']);
}
function winStatus() {
  return run('reg', ['query', WIN_RUN_KEY, '/v', WIN_RUN_NAME]).status === 0;
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

// Restart the installed service into a freshly-swapped binary (used by self-
// update). Detached so it survives the restart killing the caller — works whether
// invoked from inside the service (POST /update) or a CLI `--update`.
//   • macOS  — `launchctl kickstart -k` kills + relaunches the LaunchAgent.
//   • Linux  — `systemctl --user restart`.
//   • Windows — kill the running bridge, wait ~2s (port frees), relaunch via the
//               hidden VBS, then delete the renamed old-*.exe.
export function restartService() {
  try {
    if (process.platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    if (process.platform === 'linux') {
      spawn('systemctl', ['--user', 'restart', 'chatpanel-bridge'], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    if (process.platform === 'win32') {
      const vbs = winVbs();
      const dir = path.dirname(process.execPath);
      const cmd =
        `taskkill /IM chatpanel-bridge.exe /F >nul 2>&1 & ` +
        `timeout /t 2 >nul & wscript.exe "${vbs}" & ` +
        `del /q "${path.join(dir, 'chatpanel-bridge.old-*.exe')}" >nul 2>&1`;
      spawn('cmd', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}
