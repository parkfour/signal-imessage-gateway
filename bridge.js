const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const mime = require('mime-types');
const Database = require('better-sqlite3');

// --- Configuration ---
const config = require('./config.json');
const GROUPS_FILE = './groups.json';
const DB_FILE = './messages.db';
const SIGNAL_ATTACHMENTS_DIR = path.join(os.homedir(), '.local/share/signal-cli/attachments');

// --- SQLite Database Initialization ---
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS message_map (
        signal_timestamp TEXT PRIMARY KEY,
        apple_guid TEXT,
        group_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_message_map_apple_guid ON message_map(apple_guid);
`);

const insertMessageMap = db.prepare(`
    INSERT OR REPLACE INTO message_map (signal_timestamp, apple_guid, group_id)
    VALUES (?, ?, ?)
`);

const getMessageBySignalTimestamp = db.prepare(`
    SELECT signal_timestamp, apple_guid, group_id
    FROM message_map
    WHERE signal_timestamp = ?
`);

// --- State Management ---
// Maps iMessage Phone Number -> Signal Base64 Group ID
let groupMap = {};
if (fs.existsSync(GROUPS_FILE)) {
    try {
        groupMap = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    } catch (e) {
        console.error("[System] Failed to parse groups.json. Starting fresh.");
    }
}

function saveMap() {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(groupMap, null, 2));
}

function getNumberFromGroupId(groupId) {
    return Object.keys(groupMap).find(key => groupMap[key] === groupId);
}

// Map emoji character to Apple Tapback type
function mapEmojiToTapback(emoji) {
    if (!emoji) return 'Like';
    if (emoji === '❤️' || emoji.includes('❤️') || emoji.includes('\u2764')) return 'Love';
    if (emoji === '👍' || emoji.includes('👍')) return 'Like';
    if (emoji === '👎' || emoji.includes('👎')) return 'Dislike';
    if (emoji === '😂' || emoji.includes('😂')) return 'Laugh';
    if (emoji === '‼️' || emoji.includes('‼️') || emoji.includes('\u203c')) return 'Emphasize';
    if (emoji === '❓' || emoji.includes('❓') || emoji.includes('\u2753')) return 'Question';
    return 'Like';
}

function getExtensionForMime(mimeType) {
    if (!mimeType) return '';
    const m = mimeType.toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
    if (m.includes('png')) return '.png';
    if (m.includes('gif')) return '.gif';
    if (m.includes('webp')) return '.webp';
    if (m.includes('heic')) return '.heic';
    if (m.includes('heif')) return '.heif';
    if (m.includes('quicktime') || m.includes('mov')) return '.mov';
    if (m.includes('mp4')) return '.mp4';
    if (m.includes('webm')) return '.webm';
    if (m.includes('3gpp')) return '.3gp';
    if (m.includes('pdf')) return '.pdf';
    const ext = mime.extension(mimeType);
    return ext ? `.${ext}` : '';
}

// Locate downloaded Signal attachment in local signal-cli storage
function resolveSignalAttachment(att) {
    if (!att) return null;

    // 1. Direct path check if signal-cli ever populates storedFilename
    if (att.storedFilename && fs.existsSync(att.storedFilename)) {
        return att.storedFilename;
    }

    // 2. Exact match by id in signal-cli attachments directory
    if (att.id) {
        const directPath = path.join(SIGNAL_ATTACHMENTS_DIR, att.id);
        if (fs.existsSync(directPath)) {
            return directPath;
        }

        // 3. Prefix match by id in signal-cli attachments directory (e.g. <id>.jpg, <id>.mp4)
        if (fs.existsSync(SIGNAL_ATTACHMENTS_DIR)) {
            try {
                const files = fs.readdirSync(SIGNAL_ATTACHMENTS_DIR);
                const match = files.find(f => f.startsWith(att.id));
                if (match) {
                    return path.join(SIGNAL_ATTACHMENTS_DIR, match);
                }
            } catch (err) {
                console.error("[Signal] Error reading attachments directory:", err);
            }
        }
    }

    return null;
}

// --- Signal-CLI RPC Daemon ---
let signalDaemon = null;
let signalStdout = null;
let rpcIdCounter = 1;

function startSignalDaemon() {
    console.log("[System] Starting signal-cli daemon...");
    signalDaemon = spawn('signal-cli', ['-a', config.SERVER_SIGNAL_NUMBER, 'jsonRpc']);
    signalStdout = readline.createInterface({ input: signalDaemon.stdout, terminal: false });

    signalDaemon.stderr.on('data', (data) => {
        console.error(`[Signal-CLI] ${data.toString().trim()}`);
    });

    signalDaemon.on('exit', (code, sig) => {
        console.error(`[Signal-CLI] Process exited (code: ${code}, signal: ${sig}). Restarting in 3s...`);
        setTimeout(startSignalDaemon, 3000);
    });

    // Parse incoming Signal messages
    signalStdout.on('line', async (line) => {
        try {
            const event = JSON.parse(line);
            
            // Handle incoming messages
            if (event.method === 'receive' && event.params?.envelope?.dataMessage) {
                const envelope = event.params.envelope;
                const msg = envelope.dataMessage;
                
                // Only process messages sent BY YOU from your primary phone
                if (envelope.source === config.YOUR_PRIMARY_PHONE) {
                    
                    // --- REACTION EVENT: User reacted to a message ---
                    if (msg.reaction) {
                        const reaction = msg.reaction;
                        const targetSentTimestamp = reaction.targetSentTimestamp;
                        const emoji = reaction.emoji;

                        console.log(`[Signal] Received reaction from primary phone: ${emoji} on timestamp ${targetSentTimestamp}`);

                        if (targetSentTimestamp) {
                            // 1. Query SQLite database using targetSentTimestamp to get original Apple message_guid
                            const record = getMessageBySignalTimestamp.get(String(targetSentTimestamp));
                            if (!record || !record.apple_guid) {
                                console.warn(`[Reaction] No Apple message_guid found in database for Signal timestamp: ${targetSentTimestamp}`);
                            } else {
                                const originalMessageGuid = record.apple_guid;

                                // Determine recipient number
                                const targetIMessageNumber = (msg.groupInfo && msg.groupInfo.groupId)
                                    ? getNumberFromGroupId(msg.groupInfo.groupId)
                                    : (record.group_id ? getNumberFromGroupId(record.group_id) : null);

                                if (!targetIMessageNumber) {
                                    console.warn(`[Reaction] Could not determine recipient for group: ${msg.groupInfo?.groupId || record.group_id}`);
                                } else {
                                    // 2. Map emoji to Apple Tapback type
                                    const tapbackType = mapEmojiToTapback(emoji);
                                    console.log(`[Reaction] Mapped emoji "${emoji}" -> Tapback "${tapbackType}" for GUID ${originalMessageGuid}`);

                                    // 3. Send POST request to Mac /react route
                                    await dispatchReactionToMac(targetIMessageNumber, originalMessageGuid, tapbackType);
                                }
                            }
                        }
                        return; // Done handling reaction
                    }

                    // --- SCENARIO A: Message sent inside a mapped Group Chat ---
                    if (msg.groupInfo && msg.groupInfo.groupId) {
                        const targetIMessageNumber = getNumberFromGroupId(msg.groupInfo.groupId);
                        const signalSentTimestamp = msg.timestamp || envelope.timestamp;
                        const groupId = msg.groupInfo.groupId;
                        
                        if (targetIMessageNumber) {
                            const attachmentsToDispatch = [];

                            // Handle Attachments (Signal -> Mac)
                            if (msg.attachments && msg.attachments.length > 0) {
                                for (const att of msg.attachments) {
                                    const filePath = resolveSignalAttachment(att);
                                    if (filePath && fs.existsSync(filePath)) {
                                        try {
                                            const base64Data = fs.readFileSync(filePath, 'base64');
                                            const mimeType = att.contentType || mime.lookup(filePath) || 'application/octet-stream';
                                            let filename = att.filename || path.basename(filePath);
                                            if (!path.extname(filename)) {
                                                filename += getExtensionForMime(mimeType);
                                            }
                                            attachmentsToDispatch.push({ base64Data, mimeType, filename });
                                            // Clean up signal-cli storage to save VPS space
                                            fs.unlinkSync(filePath);
                                        } catch (readErr) {
                                            console.error("[Signal] Error processing attachment file:", readErr);
                                        }
                                    } else {
                                        console.warn(`[Signal] Could not locate attachment on disk (id: ${att.id})`);
                                    }
                                }
                            }

                            // If we have attachments, dispatch them
                            if (attachmentsToDispatch.length > 0) {
                                for (let i = 0; i < attachmentsToDispatch.length; i++) {
                                    const att = attachmentsToDispatch[i];
                                    // Send text message caption only with the first attachment
                                    const text = (i === 0) ? (msg.message || null) : null;
                                    console.log(`[Mac] Dispatching media to ${targetIMessageNumber}: ${att.filename} (${att.mimeType})`);
                                    await dispatchToMac(targetIMessageNumber, text, att.base64Data, att.mimeType, att.filename, signalSentTimestamp, groupId);
                                }
                            } else if (msg.message && msg.message.trim().length > 0) {
                                const trimmed = msg.message.trim();
                                if (trimmed === '/ping' || trimmed === '/status') {
                                    console.log(`[Command] Running round-trip health check in group ${groupId}...`);
                                    const statusReply = await getRoundTripStatus();
                                    await sendRpcCommand("send", {
                                        message: statusReply,
                                        groupId: groupId
                                    });
                                } else {
                                    // Text-only message
                                    await dispatchToMac(targetIMessageNumber, msg.message, null, null, null, signalSentTimestamp, groupId);
                                }
                            }
                        }
                    } 
                    
                    // --- SCENARIO B: Direct Message Command to the Bot ---
                    else if (!msg.groupInfo) {
                        const text = msg.message?.trim();
                        if (!text) return;
                        const lower = text.toLowerCase();
                        
                        // Listen for the "/new +1..." command
                        if (text.startsWith('/new ')) {
                            const newNumber = text.split(' ')[1]; // Extract the phone number/email
                            
                            if (groupMap[newNumber]) {
                                await sendRpcCommand("send", {
                                    message: `A group already exists for ${newNumber}.`,
                                    recipient: [config.YOUR_PRIMARY_PHONE]
                                });
                            } else {
                                console.log(`[System] Creating manual group for ${newNumber}...`);
                                try {
                                    // Create the new Signal group
                                    const groupResult = await sendRpcCommand("updateGroup", {
                                        name: `iMessage: ${newNumber}`,
                                        members: [config.YOUR_PRIMARY_PHONE]
                                    });
                                    
                                    // Save the mapping
                                    groupMap[newNumber] = groupResult.groupId;
                                    saveMap();
                                    
                                    // Send a confirmation into the newly created group
                                    await sendRpcCommand("send", {
                                        message: `Link established. You can now send iMessages to ${newNumber} in this group.`,
                                        groupId: groupResult.groupId
                                    });
                                } catch (err) {
                                    console.error("[Error] Failed to create manual group:", err);
                                }
                            }
                        } else if (
                            lower === 'are you there?' ||
                            lower === 'are you there' ||
                            lower === 'ping' ||
                            lower === '/ping' ||
                            lower === 'status' ||
                            lower === '/status' ||
                            lower === '/test'
                        ) {
                            console.log(`[Command] Running round-trip health check requested by primary phone...`);
                            const statusReply = await getRoundTripStatus();
                            await sendRpcCommand("send", {
                                message: statusReply,
                                recipient: [config.YOUR_PRIMARY_PHONE]
                            });
                        } else if (lower === '/help' || lower === 'help') {
                            const helpMsg = [
                                "Signal to iMessage Gateway Commands:",
                                "",
                                "• /new <phone_or_email>",
                                "  Create a new mapped group for an iMessage contact.",
                                "",
                                "• are you there? (or /ping)",
                                "  Test round-trip connectivity from your phone to the gateway and Mac relay."
                            ].join('\n');
                            await sendRpcCommand("send", {
                                message: helpMsg,
                                recipient: [config.YOUR_PRIMARY_PHONE]
                            });
                        }
                    }
                }
            }
        } catch (err) {
            console.error("[Signal] Error handling incoming JSON-RPC line:", err);
        }
    });
}

startSignalDaemon();

// Helper to send JSON-RPC commands to signal-cli
function sendRpcCommand(method, params) {
    return new Promise((resolve, reject) => {
        if (!signalDaemon || !signalDaemon.stdin.writable) {
            return reject(new Error("Signal daemon is not running"));
        }
        const id = rpcIdCounter++;
        const payload = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + '\n';
        
        let timer = null;
        const listener = (line) => {
            try {
                const parsed = JSON.parse(line);
                if (parsed.id === id) {
                    clearTimeout(timer);
                    signalStdout.removeListener('line', listener);
                    if (parsed.error) reject(parsed.error);
                    else resolve(parsed.result);
                }
            } catch (e) {}
        };

        timer = setTimeout(() => {
            signalStdout.removeListener('line', listener);
            reject(new Error(`sendRpcCommand(${method}) timed out after 120s`));
        }, 120000);

        signalStdout.on('line', listener);
        signalDaemon.stdin.write(payload);
    });
}

// --- Mac -> Signal HTTP Server ---
const app = express();
app.use(express.json({ limit: '500mb' })); // High limit for large video transfers
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Auth Middleware
app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${config.SHARED_TOKEN}`) next();
    else res.status(401).send("Unauthorized");
});

app.post('/receive-imessage', async (req, res) => {
    const rawSender = req.body.sender || req.body.chat_identifier || req.body.from || req.body.recipient;
    if (!rawSender) return res.status(400).send("Sender required");
    
    // Normalize sender (strip iMessage;-; / SMS;-; / tel: prefixes if present)
    const sender = rawSender.replace(/^(iMessage|SMS);-;/i, '').replace(/^tel:/i, '').trim();
    const message = req.body.message || req.body.text || req.body.body || "";
    const messageGuid = req.body.message_guid || req.body.guid || null;

    // Extract attachment supporting both Mac crapple-relay format and bridge format
    let base64Attachment = req.body.base64_data || req.body.attachment_base64 || req.body.attachment;
    let mimeType = req.body.mime_type || req.body.attachment_mime || req.body.contentType;
    let filename = req.body.filename || req.body.attachment_name || req.body.name;

    if (!base64Attachment && Array.isArray(req.body.attachments) && req.body.attachments.length > 0) {
        const first = req.body.attachments[0];
        if (typeof first === 'string') {
            base64Attachment = first;
        } else if (typeof first === 'object' && first !== null) {
            base64Attachment = first.base64_data || first.attachment_base64 || first.data || first.base64;
            mimeType = mimeType || first.mime_type || first.attachment_mime || first.contentType;
            filename = filename || first.filename || first.attachment_name || first.name;
        }
    }

    res.status(200).send("Processing"); // Acknowledge early so Mac daemon doesn't hang

    const localAttachmentPaths = [];

    try {
        // 1. Resolve or Create Signal Group
        let groupId = groupMap[sender] || groupMap[rawSender];
        if (!groupId) {
            console.log(`[Signal] Creating new group for ${sender}...`);
            const groupResult = await sendRpcCommand("updateGroup", {
                name: `iMessage: ${sender}`,
                members: [config.YOUR_PRIMARY_PHONE]
            });
            groupId = groupResult.groupId;
            groupMap[sender] = groupId;
            saveMap();
        }

        // 2. Handle Attachments (Mac -> Signal)
        if (base64Attachment) {
            let safeName = filename ? path.basename(filename) : `incoming_${Date.now()}`;
            if (!path.extname(safeName)) {
                safeName += getExtensionForMime(mimeType);
            }
            const tempPath = path.join('/tmp', `${Date.now()}_${safeName}`);
            fs.writeFileSync(tempPath, Buffer.from(base64Attachment, 'base64'));
            localAttachmentPaths.push(tempPath);
            console.log(`[Signal] Saved incoming attachment for ${sender}: ${tempPath} (${mimeType || 'unknown mime'})`);
        }

        // 3. Dispatch to Signal Group
        const rpcParams = {
            message: message || "",
            groupId: groupId
        };
        if (localAttachmentPaths.length > 0) {
            rpcParams.attachments = localAttachmentPaths;
        }

        const sendResult = await sendRpcCommand("send", rpcParams);
        console.log(`[Signal] Successfully routed message from ${sender} (attachments: ${localAttachmentPaths.length})`);

        // 4. Map Signal Timestamp to Apple Message GUID in SQLite
        const signalTimestamp = (sendResult && typeof sendResult === 'object') ? sendResult.timestamp : sendResult;
        if (signalTimestamp && messageGuid) {
            try {
                insertMessageMap.run(String(signalTimestamp), String(messageGuid), String(groupId));
                console.log(`[Database] Mapped Signal timestamp ${signalTimestamp} -> Apple GUID ${messageGuid}`);
            } catch (dbErr) {
                console.error(`[Database] Failed to insert mapping:`, dbErr.message);
            }
        }

    } catch (err) {
        console.error(`[Error] Failed to route iMessage to Signal:`, err);
    } finally {
        // 5. Always cleanup temp files
        localAttachmentPaths.forEach(p => {
            try {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (e) {}
        });
    }
});

app.listen(config.VPS_PORT, config.VPS_NEBULA_IP, () => {
    console.log(`[System] Webhook listener active on ${config.VPS_NEBULA_IP}:${config.VPS_PORT}`);
});

// --- Helper: Send HTTP POST to Mac ---
async function dispatchToMac(targetNumber, messageText, base64Data, mimeType, filename, signalSentTimestamp, groupId) {
    const url = `http://${config.MAC_NEBULA_IP}:${config.MAC_PORT}/send`;
    
    // Validate that we have either text or an attachment
    if (!messageText && !base64Data) {
        console.log(`[Mac] Skipping dispatch to ${targetNumber} (no text and no attachment)`);
        return;
    }

    const payload = { recipient: targetNumber };
    if (messageText) payload.message = messageText;

    if (base64Data) {
        // crapple-relay-12 expects base64_data, filename, mime_type
        payload.base64_data = base64Data;
        payload.filename = filename || 'attachment.bin';
        payload.mime_type = mimeType || 'application/octet-stream';

        // Provide legacy alias properties for broad compatibility
        payload.attachment_base64 = base64Data;
        payload.attachment_name = payload.filename;
        payload.attachment_mime = payload.mime_type;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.SHARED_TOKEN}`
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errBody}`);
        }
        
        const resData = await response.json().catch(() => null);
        console.log(`[Mac] Routed message to ${targetNumber}`);

        // Save Signal sent timestamp -> Apple message GUID mapping into SQLite
        const appleGuid = resData?.message_guid || resData?.guid;
        if (appleGuid && signalSentTimestamp) {
            try {
                insertMessageMap.run(String(signalSentTimestamp), String(appleGuid), String(groupId || ''));
                console.log(`[Database] Mapped Signal timestamp ${signalSentTimestamp} -> Apple GUID ${appleGuid}`);
            } catch (dbErr) {
                console.error(`[Database] Failed to insert mapping:`, dbErr.message);
            }
        }
    } catch (error) {
        console.error(`[Error] Failed to reach Mac:`, error.message);
    }
}

// --- Helper: Send Reaction / Tapback POST to Mac ---
async function dispatchReactionToMac(recipient, originalMessageGuid, tapbackType) {
    const url = `http://${config.MAC_NEBULA_IP}:${config.MAC_PORT}/react`;
    const payload = {
        recipient: recipient,
        original_message_guid: originalMessageGuid,
        tapback_type: tapbackType
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.SHARED_TOKEN}`
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errBody}`);
        }
        console.log(`[Mac] Routed Tapback "${tapbackType}" on ${originalMessageGuid} to ${recipient}`);
    } catch (error) {
        console.error(`[Error] Failed to send reaction to Mac:`, error.message);
    }
}

// --- Helper: Round-Trip Status Check (Gateway -> Mac Relay) ---
async function getRoundTripStatus() {
    const t0 = Date.now();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const url = `http://${config.MAC_NEBULA_IP}:${config.MAC_PORT}/status`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${config.SHARED_TOKEN}`
            },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const latency = Date.now() - t0;
        
        if (!response.ok) {
            return [
                "⚠️ Gateway is online, but Mac relay returned an error:",
                "",
                "• Signal Gateway: Online",
                `• Mac Relay: HTTP ${response.status} (${response.statusText || 'Error'})`,
                `• Target: ${config.MAC_NEBULA_IP}:${config.MAC_PORT}`,
                `• Latency: ${latency}ms`
            ].join('\n');
        }

        const data = await response.json();
        const imsg = data.imessage_account || (data.accounts && data.accounts.find(a => a.service === 'iMessage'));
        const login = (imsg?.login || 'Unknown').replace(/^[A-Z]:/, '');
        const conn = imsg?.connected ? 'Connected' : 'Disconnected';
        const dconn = data.daemon_connected ? 'Connected' : 'Disconnected';
        const osVersion = data.version || 'macOS';

        return [
            "Yes, I'm here! 🟢",
            "",
            "• Signal Gateway: Online",
            `• Mac Relay: Online (${latency}ms round-trip)`,
            `• macOS Host: ${osVersion}`,
            `• iMessage: ${login} (${conn})`,
            `• Apple Messages Daemon: ${dconn}`
        ].join('\n');

    } catch (err) {
        const latency = Date.now() - t0;
        const errMsg = err.name === 'AbortError' ? 'Timed out after 8s' : err.message;
        return [
            "⚠️ Gateway is online, but Mac relay is unreachable:",
            "",
            "• Signal Gateway: Online",
            `• Mac Relay: Unreachable (${errMsg})`,
            `• Target: ${config.MAC_NEBULA_IP}:${config.MAC_PORT}`,
            `• Latency: ${latency}ms`
        ].join('\n');
    }
}

