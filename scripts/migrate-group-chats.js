#!/usr/bin/env node

/**
 * Migration & Cleanup Script: Group Chat Routing
 * 
 * Migrates historical messages from misrouted 1-on-1 contact threads into
 * the proper group chat thread (chat123456789012345678), registers the
 * group conversation and participant roster in SQLite, and cleans up
 * orphaned 1-on-1 entries in groups.json.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'messages.db');
const GROUPS_FILE = process.env.GROUPS_FILE || path.join(__dirname, '..', 'groups.json');

console.log('=== Signal-iMessage Gateway Migration ===');
console.log(`Database: ${DB_FILE}`);
console.log(`Groups File: ${GROUPS_FILE}`);

// 1. Initialize SQLite schema
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

console.log('[SQLite] Schema verified and up to date.');

// 2. Upsert the Weekend Camping group thread
const GROUP_CHAT_ID = 'chat123456789012345678';
const SIGNAL_GROUP_ID = 'bqxgSplJj+Scz/xt6PFU8k2O+fCjCg9FthMdN4z0E7Y=';
const GROUP_NAME = 'Weekend Camping';
const PARTICIPANTS = [
    '+15551234567',
    '+15552345678',
    'alice@example.com',
    '+15553456789'
];

const upsertThread = db.prepare(`
    INSERT INTO conversation_threads (chat_id, signal_group_id, is_group, name, participants, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
        signal_group_id = excluded.signal_group_id,
        is_group = excluded.is_group,
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE conversation_threads.name END,
        participants = CASE WHEN excluded.participants != '[]' THEN excluded.participants ELSE conversation_threads.participants END,
        updated_at = excluded.updated_at
`);

upsertThread.run(
    GROUP_CHAT_ID,
    SIGNAL_GROUP_ID,
    1,
    GROUP_NAME,
    JSON.stringify(PARTICIPANTS),
    new Date('2026-10-17T15:46:00Z').toISOString(),
    new Date().toISOString()
);
console.log(`[SQLite] Conversation thread registered: ${GROUP_NAME} (${GROUP_CHAT_ID})`);

// 3. Migrate historical messages into message_history
const historicalMessages = [
    {
        sender: '+15551234567',
        message: '',
        has_attachment: 1,
        apple_guid: null,
        created_at: '2026-10-17T15:46:50.000Z'
    },
    {
        sender: '+15553456789',
        message: 'Count me in as well!',
        has_attachment: 0,
        apple_guid: null,
        created_at: '2026-10-17T15:52:13.000Z'
    },
    {
        sender: 'alice@example.com',
        message: 'Sounds like a great plan! Looking forward to it.',
        has_attachment: 0,
        apple_guid: '4E5D720D-3867-49C6-974D-9181ACC2829F',
        created_at: '2026-10-17T18:23:29.000Z'
    }
];

const checkExisting = db.prepare(`
    SELECT id FROM message_history
    WHERE chat_id = ? AND sender = ? AND message = ?
`);

const insertHistory = db.prepare(`
    INSERT INTO message_history (direction, chat_id, signal_group_id, sender, message, has_attachment, apple_guid, signal_timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const msg of historicalMessages) {
    const existing = checkExisting.get(GROUP_CHAT_ID, msg.sender, msg.message);
    if (!existing) {
        insertHistory.run(
            'inbound',
            GROUP_CHAT_ID,
            SIGNAL_GROUP_ID,
            msg.sender,
            msg.message,
            msg.has_attachment,
            msg.apple_guid,
            null,
            msg.created_at
        );
        console.log(`[SQLite] Inserted historical message from ${msg.sender}: "${msg.message || '(attachment)'}"`);
    } else {
        console.log(`[SQLite] Historical message from ${msg.sender} already exists in history.`);
    }
}

// 4. Clean up orphaned 1-on-1 entries in groups.json
if (fs.existsSync(GROUPS_FILE)) {
    try {
        const groupsData = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
        const backupFile = `${GROUPS_FILE}.bak.${Date.now()}`;
        fs.writeFileSync(backupFile, JSON.stringify(groupsData, null, 2));
        console.log(`[Groups] Backed up groups.json to ${backupFile}`);

        const orphanKeys = ['+15551234567', '+15553456789', 'alice@example.com'];
        let modified = false;

        for (const key of orphanKeys) {
            if (groupsData[key]) {
                console.log(`[Groups] Removing orphaned 1-on-1 mapping: ${key} -> ${groupsData[key]}`);
                delete groupsData[key];
                modified = true;
            }
        }

        // Ensure group chat is present
        if (!groupsData[GROUP_CHAT_ID]) {
            groupsData[GROUP_CHAT_ID] = SIGNAL_GROUP_ID;
            modified = true;
            console.log(`[Groups] Added mapping for ${GROUP_CHAT_ID} -> ${SIGNAL_GROUP_ID}`);
        }

        if (modified) {
            fs.writeFileSync(GROUPS_FILE, JSON.stringify(groupsData, null, 2));
            console.log('[Groups] Updated groups.json successfully.');
        } else {
            console.log('[Groups] groups.json was already clean.');
        }
    } catch (err) {
        console.error('[Groups] Failed to update groups.json:', err.message);
    }
} else {
    console.log('[Groups] groups.json does not exist. Skipping file update.');
}

console.log('=== Migration Complete ===');
