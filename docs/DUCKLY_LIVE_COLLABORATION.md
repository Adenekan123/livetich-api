# Duckly-Like Live Collaboration: Complete Architecture & Implementation Status

## Overview
This document specifies the end-to-end implementation of Duckly-like pair-programming, multi-file code sharing, interactive terminal streaming, and localhost port-forwarding across the Livetich platform:
- **Backend**: `livetich-api` (NestJS on Vultr Ubuntu 2 vCPUs, 4GB RAM)
- **Host IDE Extension**: `livetich-vscode` (Supporting Google Antigravity IDE and Visual Studio Code)
- **Web Classroom**: `livetich-web` (Next.js 16 / React 19 / CodeMirror / xterm.js)

---

## 1. Backend Gateway & Protocol (`livetich-api`)

Branch: `feat/live-share-terminal-proxy` (commit `32b9bb1`)

### A. Real-time Multi-File Code Sharing (`/code`)
- **Contracts (`src/shared/index.ts`)**:
  - `CodeFileTreeNode`: Recursive directory and file metadata structure.
  - `CodeFocusPayload`: Active focused file and cursor coordinate broadcasting for follow-the-instructor mode.
  - `CodePermissionPayload`: Live permissions (`INSTRUCTOR_ONLY`, `OPEN`, `DELEGATED`).
- **`CodeDocService` & `CodeGateway` (`src/code/`)**:
  - Manages session Yjs docs, workspace trees, and active cursor focus.
  - Gated write validation via `canWrite(sessionId, user)`.
  - Memory-efficient: Yjs documents are flushed to object storage and evicted from memory when all session participants disconnect.

### B. Terminal Streaming (`/terminal`)
- **`TerminalService` & `TerminalGateway` (`src/terminal/`)**:
  - **Memory Bounded**: Circular ring buffer backlog capped at 64KB per terminal (preventing heap growth).
  - Streams raw ANSI chunks via `term:data`.
  - Handles terminal resize geometry via `term:resize`.
  - Enforces keystroke execution permissions via `term:stdin` with sender identity validation.
  - Automatic teardown and cleanup when sockets disconnect.
  - Unit tests verified in `terminal.service.spec.ts`.

### C. Localhost Port Forwarding Tunnel & Reverse Proxy (`/tunnel` & `/proxy`)
- **`TunnelService` & `TunnelGateway` (`src/tunnel/`)**:
  - Host registers local ports (`tunnel:register` -> `{ sessionId, port, label }`).
  - Broadcasts active port list to room (`tunnel:ports`).
  - Relays incoming HTTP requests to host extension via `tunnel:request` and streams response chunks back.
- **`ProxyController` (`/proxy/:sessionId/:port/*`)**:
  - Pure streaming proxy using `res.write()` and backpressure handling. Zero in-memory buffering of large bundles or images.
  - Strips restrictive `X-Frame-Options` and `frame-ancestors` so previews embed cleanly inside web classroom iframes.
  - Sets an HTTP-only session cookie so downstream subresources (CSS, JS, images, fetch requests) work automatically without needing token parameters.
  - Fallback dark-mode status page if an unforwarded port is accessed.
  - Unit tests verified in `tunnel.service.spec.ts`.

---

## 2. Host Engine in Extension (`livetich-vscode`)

Branch: `feat/live-share-terminal-proxy` (commit `6db5cb7`)

### Google Antigravity IDE & Visual Studio Code Support
- Built to run seamlessly on both **Google Antigravity IDE** and **Visual Studio Code**:
  - Uses standard, robust Node and VS Code Extension APIs with zero vendor lock-in.
  - Deep-link support for both schemes:
    - `antigravity://UsmanAdenekan.livetich/join?sessionId=<id>`
    - `vscode://UsmanAdenekan.livetich/join?sessionId=<id>`
  - Handles protocol dispatch via `LivetichUriHandler`.

### Implemented Modules (`src/liveshare/`)
1. **`tunnel-client.ts` (`TunnelClientManager`)**:
   - Connects to `/tunnel` namespace.
   - Forwards local ports (e.g. 3000, 5173, 8080).
   - Receives `tunnel:request` from students and issues local `http.request({ host: '127.0.0.1', port })`.
   - Streams status headers and binary base64 chunks back to backend.
   - Handles client aborts.
2. **`terminal-stream.ts` (`TerminalStreamManager`)**:
   - Spawns interactive shared pseudoterminal using real host shell (`powershell.exe`/`cmd.exe` on Windows, `bash`/`zsh` on Unix).
   - Streams ANSI output chunks over `/terminal` socket via `term:data`.
   - Receives `term:stdin` keystrokes from permitted students and pipes them to the shell process.
3. **`code-sync.ts` (`CodeSyncManager`)**:
   - Scans project file tree excluding ignored directories (`.git`, `node_modules`, `dist`, `out`, `.vscode`, `build`).
   - Broadcasts project tree (`code:tree`).
   - Follow-the-instructor mode: broadcasts active editor focus and cursor coordinates (`code:focus`).
   - Synchronizes multi-file Yjs documents bi-directionally.
4. **`live-session.ts` (`LiveSessionController`)**:
   - Manages connection lifecycle and displays dedicated status bar item:
     - `🔴 Live Share :3000`
   - QuickPick Menu actions:
     - Forward Localhost Port...
     - Open Shared Terminal...
     - Collaboration Permissions (Instructor Only vs Open to All)...
     - Copy Antigravity IDE Join Link
     - Copy VS Code Join Link
     - Stop Live Sharing
5. **`live-share-view.ts` (`LiveShareViewProvider`)**:
   - Dedicated visual Sidebar Panel in the Livetich activity bar (`Live Collaboration`).
   - Displays real-time session badge, active forwarded ports list with stop buttons, terminal status, co-editing mode selectors, and 1-click deep link copy buttons.

---

## 3. Web Classroom Live Studio (`livetich-web`)

Branch: `feat/minimalist-live-session`

### Implemented Components (`src/app/sessions/[id]/`)
1. **`terminal-view.tsx` (`TerminalView`)**:
   - Powered by `@xterm/xterm` (xterm.js) and `@xterm/addon-fit`.
   - Connects to `${API_URL}/terminal`.
   - Replays initial terminal backlog on connect and streams live ANSI chunks.
   - Interactive typing support: relays student keystrokes via `term:stdin` when unlocked.
   - Responsive auto-fit on window or drawer resizing.
2. **`port-preview-view.tsx` (`PortPreviewView`)**:
   - Connects to `${API_URL}/tunnel`.
   - Port selector tabs (e.g. `:3000 Next.js App`, `:5173 Vite`).
   - Multi-device viewport toggles: Desktop (100%), Tablet (768px), Mobile (390px).
   - Address bar, reload button, and external window popout.
   - Embedded sandboxed iframe loading `${API_URL}/proxy/${sessionId}/${activePort}/`.
3. **`code-board.tsx` (`CodeBoard`)**:
   - Upgraded from simple single scratchpad into a complete Duckly-like live studio:
     - **File Tree Sidebar**: Collapsible tree displaying the host's actual workspace structure.
     - **Multi-Tab File Bar**: Switch between open project files with active highlights and close buttons.
     - **Surface Switcher**: Toggle between **Editor**, **Terminal**, and **Web Preview**.
     - **Collapsible Bottom Split Terminal**: Keep the terminal visible right below the code editor.
     - **Live Presence & Follow Mode**: Displays instructor cursor position (`Ln X, Col Y`) and co-editing status badge (`Instructor Only` vs `Co-Edit Open`).
     - **Antigravity Launcher**: Direct button to launch and open the session inside Google Antigravity IDE.
