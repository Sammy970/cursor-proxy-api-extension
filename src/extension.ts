import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

let proxyProcess: cp.ChildProcess | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let currentPort = 3010;
// Fix #1 — random token generated fresh each time the proxy starts
let proxyToken = '';

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Cursor Proxy');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'cursorProxy.toggle';
  setStatusOff();
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    outputChannel,
    vscode.commands.registerCommand('cursorProxy.toggle', () => toggle(context)),
    vscode.commands.registerCommand('cursorProxy.showLogs', () => outputChannel.show()),
    vscode.commands.registerCommand('cursorProxy.copySettings', () => copySettingsSnippet()),
  );

  const config = vscode.workspace.getConfiguration('cursorProxy');
  if (config.get<boolean>('startOnActivation')) {
    startProxy(context);
  }
}

export function deactivate() {
  stopProxy();
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function toggle(context: vscode.ExtensionContext) {
  if (proxyProcess) {
    stopProxy();
  } else {
    startProxy(context);
  }
}

// ── Node binary resolution ────────────────────────────────────────────────────

function resolveNodeBin(): string {
  // Cursor ships its own Node binary for extensions
  const appBundleRoot = path.dirname(path.dirname(path.dirname(path.dirname(process.execPath))));
  const candidates = [
    // Cursor on macOS
    path.join(appBundleRoot, 'Resources', 'app', 'resources', 'helpers', 'node'),
    // VS Code on macOS
    path.join(appBundleRoot, 'Resources', 'app', 'node_modules', '.bin', 'node'),
    // Cursor on Linux
    path.join(path.dirname(process.execPath), 'resources', 'app', 'resources', 'helpers', 'node'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) { continue; }

    // Fix #8 — validate the resolved binary is inside the expected app bundle
    // and is not world-writable (which would indicate tampering)
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved);
      const worldWritable = (stat.mode & 0o002) !== 0;
      if (worldWritable) {
        outputChannel.appendLine(`[WARN] Skipping world-writable Node binary: ${resolved}`);
        continue;
      }
      return resolved;
    } catch {
      continue;
    }
  }

  // Fall back to system node on PATH
  return 'node';
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

function startProxy(context: vscode.ExtensionContext) {
  if (proxyProcess) { return; }

  const config = vscode.workspace.getConfiguration('cursorProxy');
  currentPort = config.get<number>('port') ?? 3010;
  const model = config.get<string>('model') ?? 'anthropic/claude-sonnet-4.6';

  const serverScript = path.join(context.extensionPath, 'out', 'proxy-server.js');

  if (!fs.existsSync(serverScript)) {
    const msg = `proxy-server.js not found at: ${serverScript}`;
    outputChannel.appendLine(`[ERROR] ${msg}`);
    outputChannel.show();
    vscode.window.showErrorMessage(`Cursor Proxy: ${msg}`);
    return;
  }

  // Fix #1 — generate a fresh secret token each time the proxy starts
  proxyToken = 'sk-' + crypto.randomBytes(32).toString('hex');

  const nodeBin = resolveNodeBin();
  outputChannel.appendLine(`[INFO] Node binary: ${nodeBin}`);
  outputChannel.appendLine(`[INFO] Server script: ${serverScript}`);
  outputChannel.appendLine(`[INFO] Starting proxy on port ${currentPort}…`);
  outputChannel.show(true); // show but don't steal focus

  proxyProcess = cp.spawn(nodeBin, [serverScript], {
    env: {
      ...process.env,
      PROXY_PORT: String(currentPort),
      CURSOR_MODEL: model,
      PROXY_TOKEN: proxyToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  outputChannel.appendLine(`[INFO] Spawned PID: ${proxyProcess.pid ?? 'unknown'}`);

  let stdoutBuf = '';
  proxyProcess.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) { continue; }
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        handleChildMessage(msg);
      } catch {
        // Fix #5 — never log raw unstructured content (may contain conversation data)
        outputChannel.appendLine(`[OUT] <non-JSON line from proxy — content redacted>`);
      }
    }
  });

  proxyProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      outputChannel.appendLine(`[ERR] ${text}`);
    }
  });

  proxyProcess.on('error', (err) => {
    outputChannel.appendLine(`[ERROR] Failed to spawn process: ${err.message}`);
    outputChannel.show();
    proxyProcess = null;
    setStatusOff();
    vscode.window.showErrorMessage(`Cursor Proxy failed to start: ${err.message}`);
  });

  proxyProcess.on('exit', (code, signal) => {
    outputChannel.appendLine(`[INFO] Process exited — code=${code} signal=${signal}`);
    proxyProcess = null;
    setStatusOff();
    if (code !== 0 && code !== null) {
      vscode.window.showWarningMessage(`Cursor Proxy stopped unexpectedly (exit code ${code}). Check Output → Cursor Proxy for details.`);
    }
  });
}

function stopProxy() {
  if (!proxyProcess) { return; }
  outputChannel.appendLine('[INFO] Stopping proxy…');
  proxyProcess.kill('SIGTERM');
  proxyProcess = null;
  setStatusOff();
}

// ── Child process IPC ─────────────────────────────────────────────────────────

function handleChildMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'ready':
      setStatusOn(msg.port as number);
      outputChannel.appendLine(`[INFO] ✓ Proxy ready on http://127.0.0.1:${msg.port}`);
      writeClaudeSettings(msg.port as number).catch((err) => {
        outputChannel.appendLine(`[WARN] Could not auto-update ~/.claude/settings.json: ${err}`);
      });
      break;
    case 'log':
      outputChannel.appendLine(`[${String(msg.level).toUpperCase()}] ${msg.message}`);
      break;
    case 'request':
      outputChannel.appendLine(`[REQ]  ${String(msg.id).slice(-8)} tools=${msg.tools} msgs=${msg.msgs}`);
      break;
    case 'response':
      outputChannel.appendLine(`[RES]  ${String(msg.id).slice(-8)} ${msg.ms}ms stop=${msg.stop} tools=${msg.tools} chars=${msg.chars}`);
      break;
    case 'error':
      outputChannel.appendLine(`[ERROR] ${String(msg.id).slice(-8)} ${msg.message}`);
      break;
  }
}

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatusOn(port: number) {
  statusBarItem.text = `$(check) Cursor Proxy :${port}`;
  statusBarItem.tooltip = new vscode.MarkdownString(
    `**Cursor Proxy running** on \`http://127.0.0.1:${port}\`\n\nClick to stop`
  );
  statusBarItem.backgroundColor = undefined;
  statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
}

function setStatusOff() {
  statusBarItem.text = `$(circle-slash) Cursor Proxy`;
  statusBarItem.tooltip = 'Click to start the Cursor proxy server';
  statusBarItem.color = undefined;
  statusBarItem.backgroundColor = undefined;
}

// ── Auto-write ~/.claude/settings.json ───────────────────────────────────────

async function writeClaudeSettings(port: number) {
  const os = await import('os');
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  const settings = {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: proxyToken,
      ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
    },
  };

  await fs.promises.mkdir(claudeDir, { recursive: true });
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  outputChannel.appendLine(`[INFO] Updated ~/.claude/settings.json with current token`);
}

// ── Copy settings snippet ─────────────────────────────────────────────────────

async function copySettingsSnippet() {
  if (!proxyToken) {
    vscode.window.showWarningMessage('Start the proxy first — the settings snippet includes a security token that is generated at startup.');
    return;
  }
  const snippet = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${currentPort}`,
      ANTHROPIC_API_KEY: proxyToken,
      ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
    },
  }, null, 2);

  await vscode.env.clipboard.writeText(snippet);

  const choice = await vscode.window.showInformationMessage(
    `Copied! Paste into your project's .claude/settings.json`,
    'Open .claude/settings.json',
  );

  if (choice === 'Open .claude/settings.json') {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const settingsPath = vscode.Uri.joinPath(workspaceFolder.uri, '.claude', 'settings.json');
      try {
        await vscode.workspace.fs.stat(settingsPath);
      } catch {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, '.claude'));
        await vscode.workspace.fs.writeFile(settingsPath, Buffer.from(snippet, 'utf8'));
      }
      await vscode.window.showTextDocument(settingsPath);
    }
  }
}
