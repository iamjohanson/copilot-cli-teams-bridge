import "dotenv/config";
import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
    CloudAdapter,
    ConfigurationBotFrameworkAuthentication,
    TurnContext,
} from "botbuilder";

const RELAY_DIR = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = process.env.BRIDGE_STORE_PATH || join(RELAY_DIR, ".data", "bridge-store.json");
const PORT = Number(process.env.PORT || 3978);
const SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const BOT_DISPLAY_NAME = process.env.TEAMS_BOT_NAME || "Copilot CLI Teams Bridge";
const UPDATE_BUFFER_LIMIT = 500;

if (!process.env.MicrosoftAppId && process.env.MICROSOFT_APP_ID) {
    process.env.MicrosoftAppId = process.env.MICROSOFT_APP_ID;
}
if (!process.env.MicrosoftAppPassword && process.env.MICROSOFT_APP_PASSWORD) {
    process.env.MicrosoftAppPassword = process.env.MICROSOFT_APP_PASSWORD;
}

const APP_ID = process.env.MicrosoftAppId || "";
const APP_PASSWORD = process.env.MicrosoftAppPassword || "";
const botAuth = new ConfigurationBotFrameworkAuthentication(process.env);
const adapter = new CloudAdapter(botAuth);

adapter.onTurnError = async (context, error) => {
    console.error("teams-relay: turn error:", error);
    if (context?.sendActivity) {
        await context.sendActivity("The Teams bridge hit an error. Please try again.");
    }
};

let bridgeStore = loadBridgeStore();
const updates = [];
let nextUpdateId = 1;
const pollWaiters = new Set();

function loadBridgeStore() {
    try {
        return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    } catch (error) {
        if (error.code === "ENOENT") {
            return { conversations: {} };
        }
        throw error;
    }
}

function saveBridgeStore() {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(bridgeStore, null, 2) + "\n");
}

function relayConfigured() {
    return Boolean(APP_ID && APP_PASSWORD && SHARED_SECRET);
}

function htmlEscape(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, body) {
    res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
}

function unauthorized(res, message, statusCode = 403) {
    sendJson(res, statusCode, { ok: false, error: message });
}

function requireBridgeSecret(req, res) {
    if (!SHARED_SECRET) {
        unauthorized(res, "BRIDGE_SHARED_SECRET is not configured.", 503);
        return false;
    }
    if (req.headers["x-bridge-secret"] !== SHARED_SECRET) {
        unauthorized(res, "Invalid bridge secret.");
        return false;
    }
    return true;
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getBridgeInfoPayload() {
    return {
        ok: true,
        result: {
            username: BOT_DISPLAY_NAME,
            platform: "teams",
            endpoint: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/messages` : "/api/messages",
            configured: relayConfigured(),
            publicBaseUrl: PUBLIC_BASE_URL || null,
        },
    };
}

function normalizeMessageText(activity) {
    return typeof activity.text === "string" ? activity.text.trim() : "";
}

function buildBridgeUpdate(activity) {
    const reference = TurnContext.getConversationReference(activity);
    const conversationId = reference.conversation?.id;
    const userId = activity.from?.aadObjectId || activity.from?.id || "unknown-user";
    return {
        update_id: nextUpdateId++,
        message: {
            message_id: activity.id || randomUUID(),
            chat: { id: conversationId },
            from: {
                id: userId,
                username: activity.from?.name || userId,
            },
            text: normalizeMessageText(activity),
            attachments: (activity.attachments || []).map((attachment, index) => ({
                id: attachment.contentUrl || `attachment-${index}`,
                name: attachment.name || attachment.contentType || `attachment-${index + 1}`,
                contentType: attachment.contentType || "application/octet-stream",
            })),
        },
    };
}

function queueUpdate(activity) {
    const update = buildBridgeUpdate(activity);
    updates.push(update);
    if (updates.length > UPDATE_BUFFER_LIMIT) {
        updates.splice(0, updates.length - UPDATE_BUFFER_LIMIT);
    }
    for (const waiter of [...pollWaiters]) {
        const available = updates.filter(item => item.update_id >= waiter.offset);
        if (available.length > 0) {
            clearTimeout(waiter.timer);
            pollWaiters.delete(waiter);
            waiter.resolve(available);
        }
    }
}

async function waitForUpdates(offset, timeoutSeconds) {
    const immediate = updates.filter(item => item.update_id >= offset);
    if (immediate.length > 0) return immediate;

    return new Promise(resolve => {
        const waiter = {
            offset,
            resolve,
            timer: setTimeout(() => {
                pollWaiters.delete(waiter);
                resolve([]);
            }, timeoutSeconds * 1000),
        };
        pollWaiters.add(waiter);
    });
}

function getConversationReference(conversationId) {
    return bridgeStore.conversations?.[conversationId]?.reference || null;
}

async function continueConversation(conversationId, logic) {
    if (!relayConfigured()) {
        const error = new Error("Relay is not fully configured.");
        error.status = 503;
        throw error;
    }

    const reference = getConversationReference(conversationId);
    if (!reference) {
        const error = new Error(`No Teams conversation is known for '${conversationId}'.`);
        error.status = 404;
        throw error;
    }

    await adapter.continueConversationAsync(APP_ID, reference, logic);
}

function buildStatusPage() {
    const configured = relayConfigured();
    const publicBaseUrl = PUBLIC_BASE_URL || "https://REPLACE-WITH-YOUR-RELAY-URL";
    const setupJson = htmlEscape(JSON.stringify({
        relayUrl: publicBaseUrl,
        sharedSecret: "paste-your-BRIDGE_SHARED_SECRET-here",
    }, null, 2));

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Copilot CLI Teams Bridge Relay</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; margin: 2rem auto; max-width: 840px; line-height: 1.5; color: #1f2937; }
    .card { border: 1px solid #d1d5db; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    .ok { color: #047857; }
    .warn { color: #b45309; }
    code, pre { background: #f3f4f6; border-radius: 8px; padding: 0.15rem 0.35rem; }
    pre { padding: 1rem; overflow: auto; }
  </style>
</head>
<body>
  <h1>Copilot CLI Teams Bridge Relay</h1>
  <div class="card">
    <strong>Status:</strong>
    <span class="${configured ? "ok" : "warn"}">${configured ? "Ready for Teams traffic" : "Missing required environment variables"}</span>
    <ul>
      <li>Teams bot endpoint: <code>${htmlEscape(`${publicBaseUrl}/api/messages`)}</code></li>
      <li>Relay health endpoint: <code>${htmlEscape(`${publicBaseUrl}/api/bridge/getMe`)}</code></li>
      <li>Known personal chats: <code>${Object.keys(bridgeStore.conversations || {}).length}</code></li>
    </ul>
  </div>
  <div class="card">
    <h2>Technical validation checklist</h2>
    <ol>
      <li>Run this relay somewhere public over HTTPS, or run it locally and expose it with a public HTTPS tunnel such as Microsoft Dev Tunnels.</li>
      <li>Set <code>MicrosoftAppId</code>, <code>MicrosoftAppPassword</code>, <code>BRIDGE_SHARED_SECRET</code>, and <code>PUBLIC_BASE_URL</code>. If you start the relay from the repo root, <code>.env</code> is loaded automatically.</li>
      <li>Configure your Teams bot registration to use App ID <code>${htmlEscape(APP_ID || "YOUR-APP-ID")}</code> and point its messaging endpoint to <code>${htmlEscape(`${publicBaseUrl}/api/messages`)}</code>.</li>
      <li>Upload the Teams app package from <code>teams-app/copilot-cli-teams-bridge.zip</code> and install it for yourself in personal scope.</li>
      <li>Send the Teams app one message so the relay can store your personal chat reference.</li>
      <li>In Copilot CLI, run <code>/teams setup myteamsbot</code> and paste this JSON after replacing both placeholder values with your real relay URL and secret:</li>
    </ol>
    <pre>${setupJson}</pre>
    <p>After setup, run <code>/teams connect myteamsbot</code>, send any message in Teams, then complete the pairing code shown in Copilot CLI.</p>
    <p>If you are hosting locally, use your tunnel URL for both <code>PUBLIC_BASE_URL</code> and <code>relayUrl</code>. Do not use <code>localhost</code> inside Teams.</p>
  </div>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

        if (req.method === "GET" && url.pathname === "/") {
            sendHtml(res, 200, buildStatusPage());
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/messages") {
            if (!relayConfigured()) {
                unauthorized(res, "Relay is not fully configured.", 503);
                return;
            }
            if (!req.headers.authorization) {
                unauthorized(res, "Missing Authorization header.", 401);
                return;
            }

            const activity = await readJson(req);
            await adapter.processActivityDirect(req.headers.authorization || "", activity, async (context) => {
                if (context.activity.type !== "message") return;

                const reference = TurnContext.getConversationReference(context.activity);
                const conversationId = reference.conversation?.id;
                if (!conversationId) return;

                bridgeStore.conversations[conversationId] = {
                    reference,
                    lastSeenAt: new Date().toISOString(),
                    userId: context.activity.from?.aadObjectId || context.activity.from?.id || "unknown-user",
                    userName: context.activity.from?.name || "Unknown user",
                };
                saveBridgeStore();
                queueUpdate(context.activity);
            });

            sendJson(res, 200, { ok: true });
            return;
        }

        if (!url.pathname.startsWith("/api/bridge/")) {
            sendJson(res, 404, { ok: false, error: "Not found" });
            return;
        }

        if (!requireBridgeSecret(req, res)) {
            return;
        }

        const payload = req.method === "POST" ? await readJson(req) : {};

        if (req.method === "GET" && url.pathname === "/api/bridge/getMe") {
            sendJson(res, 200, getBridgeInfoPayload());
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/bridge/getMe") {
            sendJson(res, 200, getBridgeInfoPayload());
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/bridge/getUpdates") {
            const offset = Math.max(0, Number(payload.offset || 0));
            const timeout = Math.max(1, Math.min(30, Number(payload.timeout || 30)));
            const result = await waitForUpdates(offset, timeout);
            sendJson(res, 200, { ok: true, result });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/bridge/sendMessage") {
            const conversationId = String(payload.chat_id || "");
            const text = String(payload.text || "");
            let messageId = randomUUID();

            await continueConversation(conversationId, async (context) => {
                const response = await context.sendActivity(text);
                messageId = response?.id || messageId;
            });

            sendJson(res, 200, { ok: true, result: { message_id: messageId } });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/bridge/sendChatAction") {
            const conversationId = String(payload.chat_id || "");
            await continueConversation(conversationId, async (context) => {
                await context.sendActivity({ type: "typing" });
            });
            sendJson(res, 200, { ok: true, result: true });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/bridge/editMessageText") {
            const conversationId = String(payload.chat_id || "");
            const messageId = String(payload.message_id || "");
            const text = String(payload.text || "");

            await continueConversation(conversationId, async (context) => {
                await context.updateActivity({
                    type: "message",
                    id: messageId,
                    text,
                });
            });

            sendJson(res, 200, { ok: true, result: { message_id: messageId } });
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/bridge/deleteMessage") {
            const conversationId = String(payload.chat_id || "");
            const messageId = String(payload.message_id || "");

            await continueConversation(conversationId, async (context) => {
                await context.deleteActivity(messageId);
            });

            sendJson(res, 200, { ok: true, result: true });
            return;
        }

        sendJson(res, 404, { ok: false, error: "Unknown bridge method" });
    } catch (error) {
        console.error("teams-relay: request failed:", error);
        sendJson(res, error.status || 500, {
            ok: false,
            error: error.message || "Internal server error",
        });
    }
});

server.listen(PORT, () => {
    console.log(`teams-relay: listening on http://127.0.0.1:${PORT}`);
    if (!relayConfigured()) {
        console.log("teams-relay: set MicrosoftAppId, MicrosoftAppPassword, BRIDGE_SHARED_SECRET, and PUBLIC_BASE_URL before using Teams.");
    }
});
