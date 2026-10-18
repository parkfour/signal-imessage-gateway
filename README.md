# Signal to iMessage Gateway

A lightweight bidirectional gateway bridging Signal and Apple iMessage. It allows you to send and receive text messages, images, videos, and native reactions (Tapbacks) through Signal group chats mapped to individual iMessage contacts.

```
                      +-------------------+
                      |   Your Primary    |
                      |   Signal Phone    |
                      +---------+---------+
                                |  (Signal Protocol)
                                v
+-------------------------------+-------------------------------+
| Gateway Host (Linux VPS, Raspberry Pi, or local server)       |
|                                                               |
|   +------------------+         +--------------------------+   |
|   |  signal-cli RPC  |<------->|        bridge.js         |   |
|   |      Daemon      |         |  (Express + SQLite WAL)  |   |
|   +------------------+         +-------------+------------+   |
+----------------------------------------------|----------------+
                                               |  Encrypted Private Network
                                               |  (Tailscale / WireGuard / LAN)
                                               v
+----------------------------------------------+----------------+
| macOS Host (macOS 12+ running iMessage Relay Daemon)          |
|                                                               |
|   +-----------------------+     +-------------------------+   |
|   |   HTTP Relay Daemon   |<--->|  macOS iMessage Stack   |   |
|   |     (Port 5569)       |     |   (Apple Messages API)  |   |
|   +-----------------------+     +-------------------------+   |
+---------------------------------------------------------------+
```

---

## Features

- **Bidirectional Messaging**: Send and receive text messages seamlessly between Signal and iMessage.
- **Multi-Party Group Chats**: Supports iMessage multi-party group chats with automatic thread creation, roster synchronization, and clear inbound sender attribution (`[<sender>]: <message>`). Outbound replies route directly back to the iMessage group without requiring sender prefixes.
- **Media Support**: Transfer images (JPEG, PNG, HEIC, GIF, WebP) and videos (MP4, MOV).
- **Reaction (Tapback) Routing**: Signal emoji reactions (❤️, 👍, 👎, 😂, ‼️, ❓) are mapped directly to native Apple Tapbacks (Love, Like, Dislike, Laugh, Emphasize, Question) in both 1-on-1 and group chats.
- **Persistent State**: SQLite database (`messages.db`) with WAL mode stores thread rosters, message history, and maps Signal timestamps to Apple message GUIDs.
- **Dedicated Signal Groups**: Every iMessage contact or group chat maps to a private Signal group between you and the gateway bot. You can rename the groups anytime in Signal without breaking routing.
- **Interactive Commands**: Test round-trip health check anytime (`are you there?` or `/ping`), inspect group rosters (`/info` or `/members`), and link new contacts (`/new <number>`).

---

## Architecture & Networking Requirements

The gateway consists of two components:
1. **The Gateway Service (`bridge.js`)**: Runs on a Linux machine (or VPS/container) running Node.js and `signal-cli`.
2. **The Mac Relay Daemon**: Runs on a Mac logged into an active iMessage account, exposing an HTTP listener for outgoing messages/reactions and posting incoming messages to the gateway.

### Network Topology Options
Both hosts must be able to reach each other over HTTP on the configured port (default: `5569`). Traffic is secured with a shared Bearer token.

- **Option A: Mesh Overlay (Recommended - Tailscale / WireGuard / ZeroTier)**:
  Install Tailscale on both the gateway machine and the Mac. Use their respective 100.x.x.x IPs in the configuration.
- **Option B: Local Area Network (LAN)**:
  If both machines are on the same home network, use static local IP addresses (e.g., `192.168.1.50` and `192.168.1.60`).
- **Option C: Single-Node Deployment**:
  Run both `signal-cli`, `bridge.js`, and the Mac daemon on the same macOS machine using `127.0.0.1` (localhost).

---

## Prerequisites

- **Node.js**: v18.0.0 or higher
- **PM2**: `npm install -g pm2` (recommended for process management)
- **qrencode**: `sudo apt install qrencode` (for terminal QR code display)
- **signal-cli**: v0.13.0 or higher ([Installation Guide](https://github.com/AsamK/signal-cli))
- **Dedicated Signal Phone Number**: A second phone number (VoIP number, prepaid SIM, Google Voice, etc.) used exclusively as the gateway bot.

---

## Setup Guide

### 1. Link or Register `signal-cli`

You need to register or link the gateway bot's phone number on the gateway machine.

#### Option A: Link as a Secondary Device using QR Code (Easiest)
If you already registered your bot number on a physical device or virtual Android environment:

```bash
# Generate a linking URI and display as a terminal QR code
signal-cli link -n "Signal iMessage Gateway" | while read -r line; do
  if [[ "$line" =~ ^tsdevice: ]]; then
    qrencode -t ansiutf8 "$line"
  else
    echo "$line"
  fi
done
```
Open Signal on your phone, go to **Settings > Linked Devices > Link New Device**, and scan the QR code displayed in the terminal.

#### Option B: Register Directly via SMS / Captcha
```bash
# 1. Obtain a captcha token from https://signalcaptchas.org/registration/generate.html
# 2. Request SMS code:
signal-cli -a +1XXXXXXXXXX register --captcha "signalcaptcha://..."

# 3. Verify SMS code:
signal-cli -a +1XXXXXXXXXX verify 123456
```

---

### 2. Configure the Gateway

Clone the repository and install dependencies:

```bash
git clone <repo-url> /usr/local/src/signal-imessage-gateway
cd /usr/local/src/signal-imessage-gateway
npm install
```

Copy the example configuration:

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "VPS_NEBULA_IP": "100.x.x.1",
  "MAC_NEBULA_IP": "100.x.x.2",
  "VPS_PORT": 5569,
  "MAC_PORT": 5569,
  "SHARED_TOKEN": "generate-a-strong-random-secret-token",
  "SERVER_SIGNAL_NUMBER": "+1234567890",
  "YOUR_PRIMARY_PHONE": "+1987654321"
}
```

| Field | Description |
|---|---|
| `VPS_NEBULA_IP` | IP address of this gateway host (Tailscale IP, LAN IP, or `127.0.0.1`) |
| `MAC_NEBULA_IP` | IP address of the macOS machine running the iMessage relay |
| `VPS_PORT` | Port the gateway listens on for incoming webhooks from the Mac (e.g. `5569`) |
| `MAC_PORT` | Port the Mac daemon listens on for outbound sends and reactions (e.g. `5569`) |
| `SHARED_TOKEN` | Secret Bearer token shared between the gateway and Mac daemon |
| `SERVER_SIGNAL_NUMBER` | The phone number registered with `signal-cli` (the bot) |
| `YOUR_PRIMARY_PHONE` | Your personal phone number used in Signal (only messages from this number will be relayed) |

---

### 3. Start the Gateway with PM2

Start the process using the included `ecosystem.config.js`:

```bash
pm2 start ecosystem.config.js
pm2 save
```

To have PM2 automatically start at system boot:
```bash
pm2 startup
# Follow the command printed by PM2 (e.g. sudo env PATH=... pm2 startup systemd -u user --hp /home/user)
```

Useful PM2 commands:
```bash
pm2 status                       # Check service status
pm2 logs signal-imessage-gateway # Stream live logs
pm2 restart signal-imessage-gateway
```

---

## Usage

### Receiving Messages (iMessage &rarr; Signal)
When an external contact sends you an iMessage:
1. The Mac daemon forwards the message and attachments to `http://<gateway-ip>:5569/receive-imessage`.
2. The gateway checks if a Signal group already exists for that contact:
   - If not, it creates a new group named `iMessage: <phone_number>`.
3. The message appears in that Signal group.
4. The message's Signal timestamp is recorded in `messages.db` linked to the Apple `message_guid`.

### Replying / Sending (Signal &rarr; iMessage)
- **Replying**: Simply send text, images, or videos inside the mapped Signal group. The gateway reads the group ID, resolves the iMessage recipient, and forwards the payload to the Mac relay.
- **Starting a New Conversation**:
  Send a direct message to the bot number:
  ```text
  /new +1234567890
  ```
  The bot creates a group and confirms with: `Link established. You can now send iMessages to +1234567890 in this group.`
- **Round-Trip Health Check ("Are You There?")**:
  Send a direct message to the bot number:
  ```text
  are you there?
  ```
  *(or send `/ping` in DM or any group chat)*. The gateway tests round-trip connectivity to the macOS relay and returns the latency, macOS host info, and iMessage account connection status.

### Renaming Groups
You can safely rename any created Signal group (e.g. change `iMessage: +1234567890` to `Alice Smith`). The gateway maps chats by their immutable Signal `groupId` stored in `groups.json`, not by title.

### Sending Tapbacks (Reactions)
Add an emoji reaction to any message in the mapped Signal group. The gateway queries `messages.db` for the target message GUID and triggers a native Tapback on macOS:

| Signal Emoji | Apple Tapback |
|:---:|:---:|
| ❤️ | **Love** |
| 👍 | **Like** |
| 👎 | **Dislike** |
| 😂 | **Laugh** |
| ‼️ | **Emphasize** |
| ❓ | **Question** |
| Any other emoji | *Fallback to Like* |

---

## Route Contract (Mac Relay Specification)

If you are developing or maintaining the Mac-side relay daemon, it must satisfy the following HTTP contract:

### 1. Inbound to Gateway: `POST /receive-imessage`
Sent by the Mac daemon to the gateway when an iMessage is received.

- **URL**: `http://<gateway-ip>:<vps-port>/receive-imessage`
- **Headers**:
  ```http
  Authorization: Bearer <SHARED_TOKEN>
  Content-Type: application/json
  ```

#### Multi-Party Group Chat Payload (crapple-relay v0.2.0+)
```json
{
  "sender": "chat123456789012345678",
  "group_chat_id": "chat123456789012345678",
  "correspondent": "alice@example.com",
  "from": "alice@example.com",
  "participant": "alice@example.com",
  "participants": [
    "+15551234567",
    "+15552345678",
    "alice@example.com",
    "+15553456789"
  ],
  "is_group": true,
  "chat_identifier": "chat123456789012345678",
  "chat_guid": "iMessage;+;chat123456789012345678",
  "group_name": "Weekend Camping",
  "message": "Sounds like a great plan! Looking forward to it.",
  "message_guid": "4E5D720D-3867-49C6-974D-9181ACC2829F",
  "attachment_base64": "",
  "attachment_mime": "",
  "attachment_name": ""
}
```

#### Standard 1-on-1 Payload
```json
{
  "sender": "+1234567890",
  "message": "Hello from iMessage!",
  "message_guid": "7E1F9B3D-1234-4567-89AB-CDEF01234567",
  "is_group": false,
  "base64_data": "iVBORw0KGgoAAAANSUhEUg...",
  "mime_type": "image/jpeg",
  "filename": "photo.jpg"
}
```

### 2. Outbound to Mac: `POST /send`
Sent by the gateway to the Mac daemon to deliver an iMessage.

- **URL**: `http://<mac-ip>:<mac-port>/send`
- **Headers**:
  ```http
  Authorization: Bearer <SHARED_TOKEN>
  Content-Type: application/json
  ```
- **Body**:
  ```json
  {
    "recipient": "+1234567890",
    "message": "Reply from Signal!",
    "base64_data": "iVBORw0KGgoAAAANSUhEUg...",
    "mime_type": "image/jpeg",
    "filename": "attachment.jpg"
  }
  ```
- **Expected Success Response (`HTTP 200 OK`)**:
  ```json
  {
    "status": "success",
    "message_guid": "7E1F9B3D-1234-4567-89AB-CDEF01234567"
  }
  ```

### 3. Outbound Reaction to Mac: `POST /react`
Sent by the gateway to the Mac daemon when you react to a message in Signal.

- **URL**: `http://<mac-ip>:<mac-port>/react`
- **Headers**:
  ```http
  Authorization: Bearer <SHARED_TOKEN>
  Content-Type: application/json
  ```
- **Body**:
  ```json
  {
    "recipient": "+1234567890",
    "original_message_guid": "7E1F9B3D-1234-4567-89AB-CDEF01234567",
    "tapback_type": "Love"
  }
  ```
  *(Valid `tapback_type` values: `"Love"`, `"Like"`, `"Dislike"`, `"Laugh"`, `"Emphasize"`, `"Question"`)*

---

## File Structure

```
├── bridge.js              # Main gateway service & JSON-RPC dispatcher
├── ecosystem.config.js    # PM2 process configuration
├── config.json            # Active credentials and networking config (gitignored)
├── config.example.json    # Template configuration file
├── groups.json            # Mapping of phone numbers/groups to Signal group IDs (gitignored)
├── messages.db            # SQLite database for threads, message history & Apple GUID mappings (gitignored)
├── scripts/
│   ├── migrate-group-chats.js # Historical group chat database migration & cleanup
│   └── publish-mirror.sh      # Git mirror synchronization
├── package.json           # Node.js dependencies
└── README.md              # Project documentation
```
