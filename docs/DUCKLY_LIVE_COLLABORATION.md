# Duckly-Like Live Collaboration: Architecture & Implementation Status

## Overview
This document specifies and tracks the implementation of Duckly-like pair-programming, multi-file code sharing, terminal streaming, and localhost port-forwarding for the Livetich ecosystem.

---

## 1. What Has Been Done (Backend Gateway & Protocol in `livetich-api`)

Branch: `feat/live-share-terminal-proxy`

### A. Shared Protocol Contracts (`src/shared/index.ts`)
1. **Multi-File Code Sharing**:
   - `CodeWritePermissionMode`: `'INSTRUCTOR_ONLY' | 'OPEN' | 'DELEGATED'`
   - `CodeFileTreeNode`: Recursive directory and file tree structure metadata.
   - `CodeFocusPayload`: Active focused file and cursor coordinate broadcasting for follow-the-instructor mode.
   - `CodePermissionPayload`: Real-time permission state synchronization.
   - Socket events: `code:join`, `code:leave`, `code:update`, `code:awareness`, `code:tree`, `code:focus`, `code:permission`.

2. **Terminal Streaming**:
   - `TerminalSessionInfo`: Terminal metadata (id, name, cols, rows, interactive, writableBy, delegatedUserIds).
   - Socket events:
     - Host: `term:open`, `term:data`, `term:resize`, `term:permission`, `term:close`.
     - Viewer / Student: `term:join`, `term:leave`, `term:stdin`.
     - Server relays: `term:opened`, `term:data`, `term:resize`, `term:permission`, `term:stdin` (relayed with `fromUserId`), `term:closed`, `term:state` (with screen backlog).

3. **Localhost Port Forwarding**:
   - `ForwardedPortInfo`: Port number, label, targetUrl, registration timestamp.
   - Socket events:
     - Host: `tunnel:register`, `tunnel:unregister`, `tunnel:response:headers`, `tunnel:response:chunk`, `tunnel:response:end`, `tunnel:response:error`.
     - Viewer: `tunnel:join`, `tunnel:leave`, `tunnel:ports`.
     - Server: `tunnel:request`, `tunnel:abort`.

### B. Multi-File & Permissions in `CodeDocService` & `CodeGateway` (`src/code/`)
- Upgraded `CodeDocService` to store workspace tree, active focus, and live co-edit permission modes.
- Added strict write-permission enforcement on `code:update`:
  - Instructors and Org Admins always have write access.
  - In `OPEN` mode, enrolled students can write.
  - In `DELEGATED` mode, only students in `delegatedUserIds` can write.
  - Otherwise, students are blocked with `FORBIDDEN`.
- Automatic memory reclamation: when the last client leaves a session, Yjs documents are persisted to object storage and evicted from RAM.

### C. Terminal Streaming Module (`src/terminal/`)
- Created `TerminalService`:
  - In-memory ring buffer backlog capped at 64KB per terminal (zero risk of unbounded heap growth on 2 vCPU / 4GB RAM).
  - Terminal creation, resizing, and permission delegation.
  - Automatic cleanup when host sockets disconnect.
- Created `TerminalGateway`:
  - WebSocket gateway on `/terminal` namespace.
  - Authenticates via JWT and enforces course enrollment/session validity.
  - Broadcasts ANSI chunks and routes interactive `term:stdin` keystrokes.
- Created `TerminalModule` and registered it in `AppModule`.
- Verified with unit tests in `terminal.service.spec.ts`.

### D. Localhost Port-Forwarding Tunnel & Reverse Proxy (`src/tunnel/`)
- Created `TunnelService`:
  - Manages active forwarded port mappings per session.
  - Manages request lifecycle (chunk streaming, backpressure, 30s timeout).
  - Sanitizes hop-by-hop headers and strips `x-frame-options`/`frame-ancestors` to allow embedding in web classroom preview iframes.
- Created `TunnelGateway`:
  - WebSocket gateway on `/tunnel` namespace.
  - Receives `tunnel:register` from VS Code host extension.
  - Dispatches `tunnel:request` to host and routes response chunks back to HTTP clients.
- Created `ProxyController`:
  - Handles `/proxy/:sessionId/:port/*` routes.
  - Authenticates via query parameter `?token=...`, Authorization header, or cookie.
  - Sets an HTTP-only session cookie so downstream subresources (CSS, JS, images, fetch requests) work automatically.
  - Renders dark-themed fallback UI if host has not forwarded the requested port.
- Created `TunnelModule` and registered it in `AppModule`.
- Verified with unit tests in `tunnel.service.spec.ts`.

---

## 2. Current Status & Build Verification
- Branch: `feat/live-share-terminal-proxy`
- `nest build` completed successfully with code `0`.
- All types and contracts are verified and ready.

---

## 3. What is Left to be Done

### Phase 2: VS Code Extension Host Engine (`livetich-vscode`)
1. **Live Share Provider (`src/liveshare/code-share.ts`)**:
   - Connect to `/code` namespace with session ID.
   - Scan workspace files (filtering `.git`, `node_modules`, `dist`).
   - Emit `code:tree`.
   - Sync active text documents via Yjs updates.
   - Broadcast active editor focus on `window.onDidChangeActiveTextEditor`.
2. **Terminal Streamer (`src/liveshare/terminal-stream.ts`)**:
   - Create or hook into host terminal via `vscode.window.onDidWriteTerminalData` or pseudoterminal.
   - Stream ANSI chunks over `/terminal` namespace via `term:data`.
   - Listen for `term:stdin` from students and pipe to host terminal.
3. **Localhost Tunnel Client (`src/liveshare/tunnel-client.ts`)**:
   - Detect or let host specify active local ports (e.g. 3000, 5173).
   - Connect to `/tunnel` namespace and register ports.
   - On `tunnel:request`, perform local `http.request({ host: '127.0.0.1', port, ... })` and stream response chunks back via `tunnel:response:*`.

### Phase 3: Web Classroom UI Integration (`livetich-web`)
1. **Multi-File Code IDE**:
   - Update `code-board.tsx` to include file tree drawer and tab bar matching `minimal-session-prototype.html`.
   - Follow host cursor focus mode.
2. **Embedded Terminal**:
   - Integrate `@xterm/xterm` (xterm.js) and `@xterm/addon-fit` inside live session code panel.
   - Connect to `/terminal` socket and render ANSI stream.
   - Add permission toggle button for instructor to grant/revoke student terminal input.
3. **Live App Preview Dock**:
   - Embedded iframe pointing to `/proxy/:sessionId/:port/?token=...`.
   - Address bar, reload button, and viewport presets (Desktop, Tablet, Mobile).
