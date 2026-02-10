# AGENTS.md — Coding Agent Guidelines

## Project Overview

Multiplayer domino game as a Telegram Mini App. Single-process Python application
running a **Telegram bot** (python-telegram-bot 21.3, polling) and a **FastAPI web
server** (uvicorn) concurrently in one asyncio event loop. The frontend is vanilla JS
served as static files. Cloudflare Tunnel (trycloudflare) provides HTTPS. SQLite for
persistence via SQLAlchemy async.

## Build / Run / Test Commands

```bash
# Activate the virtual environment (Python 3.12)
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the application (bot + web server on port 8000)
python -m bot.main

# Run with Cloudflare tunnel (production) — updates BASE_URL in .env automatically
./start.sh

# Run via systemd
sudo systemctl start domino-bot
```

**Testing** — there are NO automated tests yet. Manual testing:
```bash
# Open http://localhost:8000/test in a browser to play against bots.
curl -s http://localhost:8000/api/test/create \
  -H "Content-Type: application/json" \
  -d '{"player_id": 999999, "player_name": "Tester", "num_bots": 2}'
```

If you add tests, use `pytest`. Put test files in a `tests/` directory.
Run a single test: `pytest tests/test_foo.py::test_bar -v`.

## Architecture

```
bot/main.py          — Entry point. Runs bot + web server via asyncio.gather()
bot/config.py        — All configuration from .env + game constants
bot/models.py        — SQLAlchemy ORM models + async engine (module-level singletons)
bot/db_ops.py        — Database CRUD (each function creates its own async session)
bot/game_engine.py   — Pure domino logic. NO I/O, NO async. Fully deterministic.
bot/game_manager.py  — Manages lobbies, active sessions, lifecycle (singleton)
bot/telegram_bot.py  — Telegram command/callback handlers
bot/bot_ai.py        — Simple AI for bot opponents + timed-out human takeover
web/server.py        — FastAPI app: REST API + WebSocket + static files
web/ws_manager.py    — WebSocket connection manager (singleton)
frontend/            — Vanilla HTML/CSS/JS Mini App (no build step)
```

Key design rules:
- `game_engine.py` must stay **pure** — no imports from web/, no async, no I/O.
- Singletons (`game_manager`, `ws_manager`, `engine`, `async_session_factory`) are
  created at module level and imported by reference.
- Circular imports are broken with **deferred imports** inside function bodies
  (e.g., `from bot.main import bot_app`). Do not restructure into a shared module.
- The Mini App opens via **t.me deep link** in group chats
  (`https://t.me/kh_domino_bot/kh_domino_game?startapp=GAME_ID`), not `web_app`
  inline buttons (those only work in private chats).

### API Endpoints
- `GET /api/game/{game_id}` — game state (filtered by player via auth)
- `GET /api/game/{game_id}/moves` — valid moves for authenticated player
- `POST /api/game/{game_id}/move` — play a tile `{tile, side}`
- `POST /api/game/{game_id}/pass` — pass turn (only if boneyard empty)
- `POST /api/game/{game_id}/draw` — draw from boneyard
- `POST /api/test/create` — create test game with bots
- `WS /ws/{game_id}/{player_id}` — real-time game state updates

## Python Code Style

### Formatting
- **4-space indentation**, no tabs.
- **Double quotes** for all strings and docstrings. Never single quotes.
- Soft line length limit of ~120 characters.
- **Trailing commas** in multi-line structures (dicts, function args, lists).
- Two blank lines between top-level definitions. One blank line between methods.

### Imports
Order: **stdlib → third-party → local**, separated by blank lines.

```python
import asyncio
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from sqlalchemy import select, func

from bot.config import BOT_TOKEN, MIN_PLAYERS
from bot.game_manager import game_manager
```

### Naming
| Kind | Convention | Examples |
|---|---|---|
| Functions, variables | `snake_case` | `create_lobby`, `player_infos` |
| Private methods | `_snake_case` | `_determine_first_player`, `_cleanup_lobby` |
| Classes | `PascalCase` | `DominoEngine`, `GameState`, `WSManager` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_PLAYERS`, `TILES_PER_PLAYER`, `BOT_IDS` |
| Module singletons | `snake_case` | `game_manager`, `ws_manager` |
| Bot handlers | `cmd_` / `callback_` prefix | `cmd_start_game`, `callback_join` |

### Type Annotations
- **Annotate** all function parameters and return types.
- Use `Optional[X]` from `typing` (not `X | None`) for consistency with the codebase.
- Dataclass fields are always annotated (required by `@dataclass`).
- Local variables do not need annotations.
- Prefer `list[X]`, `dict[K, V]`, `tuple[X, Y]` (lowercase builtins, Python 3.12).

### Docstrings
- Triple double-quote `"""..."""`.
- Module-level docstrings on every file (brief description of purpose).
- Function/class docstrings in imperative mood, one-liner when possible.
- No formal param/return documentation format (no Sphinx/Google/NumPy style).
- Inline parameter notes for complex signatures:

```python
async def save_game_results(group_id: int, results: list[dict]):
    """
    Save game results for a completed session.
    results: [{"game_number": 1, "winner_telegram_id": int|None, "is_fish": bool}, ...]
    """
```

### Error Handling
- **Game engine/manager**: Return `{"success": bool, "error": str|None, ...}` dicts.
  Never raise exceptions for invalid moves or game-state violations.
- **FastAPI endpoints**: Raise `HTTPException` with appropriate status codes
  (400 for bad input, 401 for auth, 404 for not found).
- **WebSocket/callback code**: Catch `Exception`, log with `logger.error(...)`,
  clean up connections. Don't let errors crash the event loop.
- **Constructor validation**: `raise ValueError` for truly invalid inputs
  (e.g., wrong player count).

### Async Patterns
- `asyncio.create_task()` for fire-and-forget background work (bot AI turns, timers).
- `async with async_session_factory() as session:` for all DB operations
  (each function manages its own session, no DI).
- The game engine is **synchronous by design** — call it from async code directly
  (it's CPU-bound and fast).
- Use deferred imports (`from bot.main import bot_app` inside a function body)
  to break circular dependencies.

## JavaScript Code Style

### Structure
- **Global object literal singletons**: `TG`, `WS`, `SFX`, `Game`, `App`.
- No modules, no bundler, no transpiler. Script tags in dependency order.
- **camelCase** for methods and properties.
- **PascalCase** for `Game` and `App`; abbreviations for `TG`, `WS`, `SFX`.
- Private-ish methods prefixed with `_` (e.g., `_startPing`, `_tryReconnect`).
- DOM IDs and CSS classes use **kebab-case**.

### Conventions
- JSDoc `/** ... */` blocks on all methods. `@param` tags optional.
- Single quotes for strings, template literals for interpolation.
- `async/await` for all fetch calls. Errors caught with `try/catch` + `console.error`.
- Haptic feedback via `TG.hapticFeedback()` on user-facing actions (moves, errors).
- Guard-clause early returns for null/missing data.
- Game ID read from URL param `?game_id=` or Telegram `start_param` (deep link).

## CSS Conventions
- CSS custom properties (`--var-name`) for theming via Telegram's `--tg-theme-*` vars.
- BEM-ish class naming: `.domino-tile`, `.tile-half`, `.side-btn`.
- State via chained classes: `.domino-tile.selected`, `.domino-tile.playable`.
- Mobile-first with `@media (max-height: 600px)` for small screens.
- Animations via `@keyframes` (no JS animation).

## Environment & Configuration
- All secrets in `.env` (never committed — listed in `.gitignore`).
- Required env vars: `BOT_TOKEN`, `BASE_URL`, `WEB_HOST`, `WEB_PORT`.
- Game constants live in `bot/config.py` as module-level `UPPER_SNAKE_CASE`.
- No Alembic migrations. Schema changes require deleting `data/domino.db`.
- The Mini App domain must be registered in **BotFather** (`/newapp` or `/setdomain`)
  for the t.me deep link to work. Current short name: `kh_domino_game`.

## Common Pitfalls
- The `.env` `BASE_URL` changes on every restart when using trycloudflare.
  `start.sh` updates it automatically. The BotFather domain must also be updated.
- `game_manager.sessions` is in-memory only — server restart loses active games.
- The `Player` table lacks a unique constraint on `(telegram_id, group_id)`.
- `models.get_session()` is dead code (async generator, never used). Ignore it.
- `web_app` inline keyboard buttons only work in **private chats** with the bot.
  For group chats, use a `url` button with the t.me deep link format.
- Cloudflare tunnel must point to `http://127.0.0.1:8000` (not `localhost`) to
  avoid IPv6 resolution failures.
- LSP (Pyright) reports many false positives about `None` attributes and type
  mismatches. These are due to the venv not being in the LSP path and runtime
  guards before function calls. All code works correctly at runtime.
