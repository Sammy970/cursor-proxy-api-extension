# Cursor Proxy

A VS Code / Cursor extension that runs a local HTTP proxy, letting you use Claude Code with your active Cursor subscription instead of a separate Anthropic API key.

The proxy speaks the Anthropic Messages API on the inside (so Claude Code connects to it without any changes) and translates requests to Cursor's model API on the outside.

---

## How it works

When you start the proxy, the extension:

1. Spawns a lightweight Node.js HTTP server bound to `127.0.0.1` on a configurable port (default 3010).
2. Generates a random secret token and writes it to `~/.claude/settings.json` automatically.
3. Translates every Anthropic `/v1/messages` request into a Cursor API call using your active Cursor session.
4. Converts the streamed response back into the Anthropic SSE format that Claude Code expects, including full tool use support.

Claude Code never knows it is talking to anything other than the Anthropic API.

---

## Requirements

- Cursor IDE with an active subscription (the proxy uses your logged-in Cursor session).
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code --registry https://registry.npmjs.org`).

---

## Installation

1. Download the latest `.vsix` from the [Releases](https://github.com/Sammy970/cursor-proxy-api-extension/releases) page.
2. In Cursor, open the Command Palette and run `Extensions: Install from VSIX...`.
3. Select the downloaded file and reload when prompted.

---

## Usage

**Starting the proxy**

Click the `Cursor Proxy` item in the status bar, or open the Command Palette and run `Cursor Proxy: Toggle On/Off`. The status bar item turns green when the proxy is running.

The extension automatically updates `~/.claude/settings.json` with the correct base URL and a fresh token. You do not need to configure anything manually.

**Stopping the proxy**

Click the status bar item again, or run `Cursor Proxy: Toggle On/Off` from the Command Palette.

**Viewing logs**

Run `Cursor Proxy: Show Logs` from the Command Palette to open the Output panel. Every request and response is logged with timing and tool call counts.

**Using Claude Code**

Once the proxy is running, just run `claude` in any terminal as normal. It will route through the proxy automatically.

---

## Configuration

All settings are under `Cursor Proxy` in VS Code / Cursor settings.

| Setting | Default | Description |
|---|---|---|
| `cursorProxy.port` | `3010` | Port the proxy listens on |
| `cursorProxy.model` | `anthropic/claude-sonnet-4.6` | Cursor model to use |
| `cursorProxy.startOnActivation` | `false` | Start the proxy automatically on IDE launch |

---

## Security

The proxy is designed to be safe to run locally. Here is what it does to limit its attack surface:

**Loopback only.** The server binds exclusively to `127.0.0.1`. It is not reachable from other machines on your network or from the wider internet.

**Per-session secret token.** A cryptographically random token is generated each time the proxy starts. Every incoming request must present this token in the `x-api-key` header. Requests without a valid token receive a `401` and are dropped immediately. The comparison uses a constant-time function to prevent timing attacks.

**No CORS headers.** The proxy does not emit `Access-Control-Allow-Origin` headers, so browser pages cannot make cross-origin requests to it even if they know the port.

**Body size limit.** Incoming request bodies are capped at 10 MB. Oversized requests are rejected and the connection is destroyed before the body is fully read.

**Prompt injection protection.** Tool results (file contents, command output, etc.) are wrapped in clearly delimited `<tool_result>` tags before being sent to the model. The system prompt instructs the model to treat content inside those tags as inert data, not as instructions.

**No conversation content in logs.** The Output channel only receives structured metadata (request ID, tool count, message count, response time). Raw conversation content is never written to the VS Code Output panel, which is accessible to other installed extensions.

**Node binary validation.** The extension resolves Cursor's bundled Node binary by walking the application bundle path. Before using the resolved binary it checks that the file is not world-writable, guarding against a tampered or symlink-replaced executable.

---

## License

MIT — see [LICENSE](./LICENSE).
