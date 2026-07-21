# livetich

Live-teaching platform: instructors teach skills over interactive live streams — chalkboard, chat, raise-hand, quizzes with a public points leaderboard, a "millionaire-style" buzzer round, and verifiable certificates.

## Stack

| Layer | Choice |
|---|---|
| Backend | NestJS (`apps/api`) |
| Frontend | Next.js (`apps/web`) |
| Shared realtime contract | `packages/shared` (typed Socket.IO events) |
| Database | MySQL 8 + Prisma |
| Realtime state | Socket.IO + Redis adapter (room-sharded, server-authoritative timing) |
| Media | LiveKit (WebRTC SFU) — instructor publishes, students subscribe, screen-share by grant |
| Queue | BullMQ (certificates, recordings, notifications) |
| Object storage | Cloudflare R2 (recordings, certificate PDFs) |
| Chalkboard | tldraw/Excalidraw + Yjs (planned) |

Max class size target: 500 students (single LiveKit room; 1–2 publishers at a time).

## Getting started

```bash
pnpm install
docker compose up -d            # MySQL 8 + Redis
cp .env.example apps/api/.env   # then fill in secrets
pnpm db:migrate                 # prisma migrate dev
pnpm dev:api                    # NestJS on :3000
pnpm dev:web                    # Next.js on :3001 (or next free port)
```

## Architecture notes

- **Buzzer round** (who-wants-to-be-a-millionaire style): server-side state machine
  `IDLE → COLLECTING → QUESTION_OPEN (60s) → WINNER | TIMEOUT → QA → IDLE`.
  Answers are ordered by **server receipt time** (`QuizAnswer.receivedAt`,
  DATETIME(3)) — never client clocks.
- **Points**: `PointsLedger` is append-only truth; the live leaderboard is a Redis
  sorted set (`leaderboard:{courseId}`) projection, rebuildable from the ledger.
  Broadcasts are batched (1–2s tick), not per-event.
- **Certificates**: issuance enqueues a BullMQ job → PDF render → R2 upload →
  public verification at `/verify/{code}` via QR.
- **Screen share** (#8): app emits `screen-share:grant` → api updates the LiveKit
  participant's publish permission; revoke mirrors it.

## Roadmap (module stubs in `apps/api/src`)

1. `auth` — JWT auth, roles; same identity claims embedded in LiveKit tokens
2. `courses` — courses/sections/enrollments CRUD
3. `sessions` — session lifecycle, LiveKit token minting, egress recording
4. `room-gateway` — presence, chat (+lock), hands, typed events (skeleton exists)
5. `quiz` — section quizzes + buzzer state machine
6. `points` — ledger + Redis leaderboard projection
7. `certificates` — BullMQ worker, PDF + QR, verify endpoint
8. `board` — Yjs chalkboard sync + snapshots
