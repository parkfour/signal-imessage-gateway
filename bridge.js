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

    CREATE TABLE IF NOT EXISTS conversation_threads (
        chat_id TEXT PRIMARY KEY,
        signal_group_id TEXT,
        is_group INTEGER DEFAULT 0,
        name TEXT,
        participants TEXT,
        created_at TEXT,
        updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conv_signal_group_id ON conversation_threads(signal_group_id);

    CREATE TABLE IF NOT EXISTS message_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT,
        chat_id TEXT,
        signal_group_id TEXT,
        sender TEXT,
        message TEXT,
        has_attachment INTEGER DEFAULT 0,
        apple_guid TEXT,
        signal_timestamp TEXT,
        created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_history_chat_id ON message_history(chat_id);
    CREATE INDEX IF NOT EXISTS idx_msg_history_apple_guid ON message_history(apple_guid);
    CREATE INDEX IF NOT EXISTS idx_msg_history_signal_timestamp ON message_history(signal_timestamp);
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

const upsertConversationThread = db.prepare(`
    INSERT INTO conversation_threads (chat_id, signal_group_id, is_group, name, participants, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
        signal_group_id = excluded.signal_group_id,
        is_group = excluded.is_group,
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE conversation_threads.name END,
        participants = CASE WHEN excluded.participants != '[]' THEN excluded.participants ELSE conversation_threads.participants END,
        updated_at = excluded.updated_at
`);

const getConversationThread = db.prepare(`
    SELECT chat_id, signal_group_id, is_group, name, participants, created_at, updated_at
    FROM conversation_threads
    WHERE chat_id = ?
`);

const getThreadByGroupId = db.prepare(`
    SELECT chat_id, signal_group_id, is_group, name, participants, created_at, updated_at
    FROM conversation_threads
    WHERE signal_group_id = ?
`);

const insertMessageHistory = db.prepare(`
    INSERT INTO message_history (direction, chat_id, signal_group_id, sender, message, has_attachment, apple_guid, signal_timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    if (!groupId) return null;
    const direct = Object.keys(groupMap).find(key => groupMap[key] === groupId);
    if (direct) return direct;
    try {
        const row = getThreadByGroupId.get(groupId);
        if (row && row.chat_id) return row.chat_id;
    } catch (e) {}
    return null;
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

    // Check if we need to send a post-restart confirmation to Signal
    setTimeout(checkRestartNotification, 3500);

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
                                const lower = trimmed.toLowerCase();
                                if (
                                    lower === '/ping' ||
                                    lower === '/status' ||
                                    lower === 'are you there?' ||
                                    lower === 'are you there' ||
                                    lower === 'ping'
                                ) {
                                    console.log(`[Command] Running round-trip health check in group ${groupId}...`);
                                    const statusReply = await getRoundTripStatus();
                                    await sendRpcCommand("send", {
                                        message: statusReply,
                                        groupId: groupId
                                    });
                                } else if (lower === '/info' || lower === '/members' || lower === '/roster') {
                                    const thread = getThreadByGroupId.get(groupId);
                                    let reply = `Group Info:\n`;
                                    if (thread) {
                                        reply += `• iMessage ID: ${thread.chat_id}\n`;
                                        if (thread.name) reply += `• Group Name: ${thread.name}\n`;
                                        let members = [];
                                        try { members = JSON.parse(thread.participants || '[]'); } catch (e) {}
                                        if (members.length > 0) {
                                            reply += `• Participants (${members.length}):\n` + members.map(m => `  - ${m}`).join('\n');
                                        } else {
                                            reply += `• Participants: (none recorded)`;
                                        }
                                    } else {
                                        reply += `• Target: ${targetIMessageNumber || 'Unknown'}\n• Signal Group: ${groupId}`;
                                    }
                                    await sendRpcCommand("send", {
                                        message: reply,
                                        groupId: groupId
                                    });
                                } else if (
                                    lower === '/restart' ||
                                    lower === 'restart' ||
                                    lower.startsWith('/restart ') ||
                                    lower.startsWith('restart ')
                                ) {
                                    const parts = trimmed.split(/\s+/);
                                    const arg = parts.slice(1).join(' ').trim();
                                    const sendReply = async (message) => {
                                        await sendRpcCommand("send", { message, groupId });
                                    };
                                    sendReply.target = { groupId };
                                    await handleRestartCommand(sendReply, arg);
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
                        } else if (
                            lower === '/restart' ||
                            lower === 'restart' ||
                            lower.startsWith('/restart ') ||
                            lower.startsWith('restart ')
                        ) {
                            const parts = text.split(/\s+/);
                            const arg = parts.slice(1).join(' ').trim();
                            const sendReply = async (message) => {
                                await sendRpcCommand("send", {
                                    message,
                                    recipient: [config.YOUR_PRIMARY_PHONE]
                                });
                            };
                            sendReply.target = { recipient: [config.YOUR_PRIMARY_PHONE] };
                            await handleRestartCommand(sendReply, arg);
                        } else if (lower === '/help' || lower === 'help') {
                            const helpMsg = [
                                "Signal to iMessage Gateway Commands:",
                                "",
                                "• /new <phone_or_email>",
                                "  Create a new mapped group for an iMessage contact.",
                                "",
                                "• are you there? (or /ping, /status)",
                                "  Test round-trip connectivity from your phone to the gateway and Mac relay.",
                                "",
                                "• /restart (or /restart both, /restart mac)",
                                "  Restart the gateway daemon, or both Mac relay and gateway.",
                                "",
                                "• /info (or /members, in a group thread)",
                                "  Display participants roster and iMessage thread details."
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

app.post('/admin/sync', async (req, res) => {
    try {
        const results = {};
        // 1. Rename Weekend Camping group if needed
        const groupChatId = 'chat123456789012345678';
        const targetSignalId = groupMap[groupChatId];
        if (targetSignalId) {
            try {
                const renameResult = await sendRpcCommand("updateGroup", {
                    groupId: targetSignalId,
                    name: "iMessage: Weekend Camping"
                });
                results.rename = { status: "success", result: renameResult };
            } catch (renameErr) {
                results.rename = { status: "error", message: renameErr.message };
            }
        }

        // 2. Clean up orphan groups if requested
        const orphanGroups = req.body.orphan_groups || [
            "KWuktsAg4EOBgVTn7zRW16rcbtJH1+nI4YLxTl1wa70=",
            "NvDq8IAM6BghgDcJegAl7VGZ9USTYdUTr7chFSjaciA=",
            "FpQwAy9FUIV+BXeFnb4rXidjSG59ZcDSafgyxIF+QBY="
        ];

        results.orphans = [];
        if (req.body.notify_orphans) {
            for (const gid of orphanGroups) {
                try {
                    await sendRpcCommand("send", {
                        message: "ℹ️ This 1-on-1 thread was created in error before group chat routing was active. All group messages are now delivered to 'iMessage: Weekend Camping'. You can safely delete or archive this conversation.",
                        groupId: gid
                    });
                    results.orphans.push({ groupId: gid, notified: true });
                } catch (e) {
                    results.orphans.push({ groupId: gid, notified: false, error: e.message });
                }
            }
        }

        return res.json({ success: true, results });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/restart', async (req, res) => {
    const target = (req.body?.target || req.query?.target || 'gateway').toString().trim().toLowerCase();
    res.status(200).json({ status: "initiating_restart", target });

    if (target === 'both' || target === 'all') {
        triggerMacRestart().finally(() => {
            restartSelf(1500);
        });
    } else if (target === 'mac' || target === 'relay') {
        triggerMacRestart();
    } else {
        restartSelf(1000);
    }
});

app.post('/receive-imessage', async (req, res) => {
    // 1. Group vs 1-on-1 Detection
    const isGroup = Boolean(
        req.body.is_group === true ||
        (req.body.group_chat_id && String(req.body.group_chat_id).trim().length > 0) ||
        (req.body.chat_guid && String(req.body.chat_guid).includes(';+;')) ||
        (req.body.sender && String(req.body.sender).startsWith('chat'))
    );

    // 2. Resolve Chat Key (thread identifier)
    let chatKey = '';
    if (isGroup) {
        chatKey = (req.body.group_chat_id || req.body.chat_identifier || req.body.sender || '').trim();
        chatKey = chatKey.replace(/^(iMessage|SMS);[+-];/i, '').replace(/^chat:/i, '').trim();
    } else {
        const rawSender = req.body.sender || req.body.chat_identifier || req.body.from || req.body.recipient;
        if (!rawSender) return res.status(400).send("Sender required");
        chatKey = rawSender.replace(/^(iMessage|SMS);[+-];/i, '').replace(/^tel:/i, '').trim();
    }

    if (!chatKey) {
        return res.status(400).send("Chat identifier or sender required");
    }

    // 3. Sender / Correspondent Attribution
    let author = '';
    if (isGroup) {
        const rawAuthor = req.body.correspondent || req.body.from || req.body.participant || '';
        author = rawAuthor.replace(/^(iMessage|SMS);-;/i, '').replace(/^tel:/i, '').trim();
    } else {
        author = chatKey;
    }

    // 4. Participants Roster
    let participants = [];
    if (Array.isArray(req.body.participants) && req.body.participants.length > 0) {
        participants = req.body.participants.map(p =>
            String(p).replace(/^(iMessage|SMS);-;/i, '').replace(/^tel:/i, '').trim()
        ).filter(Boolean);
    } else if (author) {
        participants = [author];
    }

    const message = req.body.message || req.body.text || req.body.body || "";
    const messageGuid = req.body.message_guid || req.body.guid || null;
    const groupName = req.body.group_name?.trim() || "";

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
        // 5. Resolve or Create Signal Group
        let groupId = groupMap[chatKey];
        const displayTitle = groupName
            ? `iMessage: ${groupName}`
            : (isGroup ? `iMessage Group: ${chatKey}` : `iMessage: ${chatKey}`);

        if (!groupId) {
            console.log(`[Signal] Creating new group for ${chatKey} (${displayTitle})...`);
            const groupResult = await sendRpcCommand("updateGroup", {
                name: displayTitle,
                members: [config.YOUR_PRIMARY_PHONE]
            });
            groupId = groupResult.groupId;
            groupMap[chatKey] = groupId;
            saveMap();
        } else if (isGroup && groupName) {
            // Check if group title needs update
            try {
                const existingThread = getConversationThread.get(chatKey);
                if (!existingThread || !existingThread.name || existingThread.name !== groupName) {
                    await sendRpcCommand("updateGroup", {
                        groupId: groupId,
                        name: displayTitle
                    });
                    console.log(`[Signal] Updated group title to "${displayTitle}" for ${chatKey}`);
                }
            } catch (renameErr) {
                console.warn(`[Signal] Note on group rename:`, renameErr.message);
            }
        }

        // 6. Update Conversation Thread Roster in SQLite
        try {
            upsertConversationThread.run(
                chatKey,
                groupId,
                isGroup ? 1 : 0,
                groupName,
                JSON.stringify(participants),
                new Date().toISOString(),
                new Date().toISOString()
            );
        } catch (threadErr) {
            console.error(`[Database] Failed to upsert thread record:`, threadErr.message);
        }

        // 7. Format Message with Attribution for Groups
        let signalMessageText = message;
        if (isGroup && author) {
            if (signalMessageText && signalMessageText.trim().length > 0) {
                signalMessageText = `[${author}]: ${signalMessageText}`;
            } else {
                signalMessageText = `[${author}]`;
            }
        }

        // 8. Handle Attachments (Mac -> Signal)
        if (base64Attachment) {
            let safeName = filename ? path.basename(filename) : `incoming_${Date.now()}`;
            if (!path.extname(safeName)) {
                safeName += getExtensionForMime(mimeType);
            }
            const tempPath = path.join('/tmp', `${Date.now()}_${safeName}`);
            fs.writeFileSync(tempPath, Buffer.from(base64Attachment, 'base64'));
            localAttachmentPaths.push(tempPath);
            console.log(`[Signal] Saved incoming attachment for ${chatKey}: ${tempPath} (${mimeType || 'unknown mime'})`);
        }

        // 9. Dispatch to Signal Group
        const rpcParams = {
            message: signalMessageText || "",
            groupId: groupId
        };
        if (localAttachmentPaths.length > 0) {
            rpcParams.attachments = localAttachmentPaths;
        }

        const sendResult = await sendRpcCommand("send", rpcParams);
        console.log(`[Signal] Successfully routed message for ${chatKey} from ${author || chatKey} (attachments: ${localAttachmentPaths.length})`);

        // 10. Map Signal Timestamp to Apple Message GUID in SQLite
        const signalTimestamp = (sendResult && typeof sendResult === 'object') ? sendResult.timestamp : sendResult;
        if (signalTimestamp && messageGuid) {
            try {
                insertMessageMap.run(String(signalTimestamp), String(messageGuid), String(groupId));
                console.log(`[Database] Mapped Signal timestamp ${signalTimestamp} -> Apple GUID ${messageGuid}`);
            } catch (dbErr) {
                console.error(`[Database] Failed to insert mapping:`, dbErr.message);
            }
        }

        // 11. Record into message_history
        try {
            insertMessageHistory.run(
                'inbound',
                chatKey,
                groupId,
                author || chatKey,
                message || '',
                localAttachmentPaths.length > 0 ? 1 : 0,
                messageGuid ? String(messageGuid) : null,
                signalTimestamp ? String(signalTimestamp) : null,
                new Date().toISOString()
            );
        } catch (histErr) {
            console.error(`[Database] Failed to record message history:`, histErr.message);
        }

    } catch (err) {
        console.error(`[Error] Failed to route iMessage to Signal:`, err);
    } finally {
        // 12. Always cleanup temp files
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

    const payload = {
        recipient: targetNumber,
        chat_identifier: targetNumber
    };
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

        // Record in message_history
        try {
            insertMessageHistory.run(
                'outbound',
                targetNumber,
                groupId || null,
                config.YOUR_PRIMARY_PHONE,
                messageText || '',
                base64Data ? 1 : 0,
                appleGuid ? String(appleGuid) : null,
                signalSentTimestamp ? String(signalSentTimestamp) : null,
                new Date().toISOString()
            );
        } catch (histErr) {
            console.error(`[Database] Failed to record outbound history:`, histErr.message);
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
        chat_identifier: recipient,
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
        const relayVer = data.relay_version || data.relay_version_string || data.version || 'Unknown';
        const macosVer = data.macos_version || data.os_version || 'macOS';

        return [
            "Yes, I'm here! 🟢",
            "",
            "• Signal Gateway: Online",
            `• Mac Relay: Online (${latency}ms round-trip)`,
            `• Relay Version: ${relayVer}`,
            `• macOS Host: ${macosVer}`,
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

// --- Restart Commands and State Management ---
const RESTART_MARKER_FILE = path.join(os.tmpdir(), 'signal_gateway_restart_marker.json');

async function triggerMacRestart() {
    const url = `http://${config.MAC_NEBULA_IP}:${config.MAC_PORT}/restart`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        console.log(`[Mac] Requesting Mac relay restart at ${url}...`);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.SHARED_TOKEN}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });
        clearTimeout(timer);
        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return { ok: false, error: `HTTP ${response.status}: ${errText || response.statusText}` };
        }
        const data = await response.json().catch(() => ({}));
        return { ok: true, data };
    } catch (err) {
        clearTimeout(timer);
        // If daemon terminates immediately, connection reset/abort is expected
        if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.message?.includes('socket hang up')) {
            console.log(`[Mac] Restart request dispatched; connection closed or timed out as expected during reset.`);
            return { ok: true, note: 'Restart command dispatched (connection reset during daemon reload)' };
        }
        return { ok: false, error: err.message };
    }
}

function restartSelf(delayMs = 1500) {
    console.log(`[System] Restarting gateway daemon in ${delayMs}ms...`);
    setTimeout(() => {
        if (signalDaemon) {
            signalDaemon.removeAllListeners('exit');
            try {
                signalDaemon.kill('SIGTERM');
            } catch (e) {}
        }
        process.exit(0);
    }, delayMs);
}

function saveRestartMarker(target, both = false) {
    try {
        fs.writeFileSync(RESTART_MARKER_FILE, JSON.stringify({
            target: target,
            both: both,
            timestamp: Date.now()
        }));
        console.log(`[System] Saved restart marker for target:`, target);
    } catch (e) {
        console.error("[System] Failed to write restart marker:", e.message);
    }
}

async function checkRestartNotification() {
    if (!fs.existsSync(RESTART_MARKER_FILE)) return;
    try {
        const marker = JSON.parse(fs.readFileSync(RESTART_MARKER_FILE, 'utf8'));
        fs.unlinkSync(RESTART_MARKER_FILE);

        // Only send confirmation if restarted recently (within 2 minutes)
        if (Date.now() - marker.timestamp < 120000) {
            console.log("[System] Found active restart marker. Checking round-trip status...");
            const statusReply = await getRoundTripStatus();
            const header = marker.both
                ? "🟢 Both iMessage relay and Signal gateway have restarted successfully!"
                : "🟢 Signal gateway daemon has restarted successfully!";
            const fullMsg = `${header}\n\n${statusReply}`;

            const rpcParams = { message: fullMsg };
            if (marker.target?.groupId) {
                rpcParams.groupId = marker.target.groupId;
            } else if (marker.target?.recipient) {
                rpcParams.recipient = marker.target.recipient;
            } else {
                rpcParams.recipient = [config.YOUR_PRIMARY_PHONE];
            }

            await sendRpcCommand("send", rpcParams).catch(err => {
                console.error("[System] Failed to deliver post-restart notification:", err.message);
            });
        }
    } catch (e) {
        console.error("[System] Error processing restart marker:", e.message);
    }
}

async function handleRestartCommand(sendReply, arg = '') {
    const normalized = (arg || '').trim().toLowerCase();

    if (normalized === 'both' || normalized === 'all') {
        await sendReply("🔄 [1/2] Triggering restart on iMessage Mac relay...");
        const macResult = await triggerMacRestart();
        if (macResult.ok) {
            await sendReply("✅ Mac relay restart initiated.\n🔄 [2/2] Restarting Signal gateway in 2s...");
        } else {
            await sendReply(`⚠️ Mac relay restart returned: ${macResult.error}\n🔄 Proceeding to restart Signal gateway in 2s...`);
        }
        saveRestartMarker(sendReply.target, true);
        restartSelf(2000);
        return;
    }

    if (normalized === 'mac' || normalized === 'relay') {
        await sendReply("🔄 Triggering restart of iMessage Mac relay...");
        const macResult = await triggerMacRestart();
        if (!macResult.ok) {
            await sendReply(`⚠️ Failed to trigger Mac relay restart: ${macResult.error}`);
            return;
        }
        await sendReply("✅ Mac relay restart signal sent. Verifying connectivity in 6s...");
        setTimeout(async () => {
            const status = await getRoundTripStatus();
            await sendReply(`Mac Relay Status:\n\n${status}`);
        }, 6000);
        return;
    }

    // Default: Restart gateway only
    await sendReply("🔄 Restarting Signal-iMessage gateway daemon in 1s...");
    saveRestartMarker(sendReply.target, false);
    restartSelf(1500);
}

