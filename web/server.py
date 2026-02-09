"""
FastAPI web server: serves the Mini App frontend, REST API, and WebSocket.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import urllib.parse
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse

from bot.config import BOT_TOKEN
from bot.game_manager import game_manager
from bot.bot_ai import is_bot_player, maybe_play_bot_turns
from web.ws_manager import ws_manager

logger = logging.getLogger(__name__)

app = FastAPI(title="Domino Game")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


def validate_init_data(init_data: str) -> dict | None:
    """
    Validate Telegram Mini App initData using HMAC-SHA-256.
    Returns parsed data dict if valid, None otherwise.
    """
    try:
        parsed = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        received_hash = parsed.pop("hash", "")
        if not received_hash:
            return None

        # Build the data-check-string
        data_check_arr = sorted(parsed.items())
        data_check_string = "\n".join(f"{k}={v}" for k, v in data_check_arr)

        # Create secret key
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

        if hmac.compare_digest(computed_hash, received_hash):
            # Parse the user field
            if "user" in parsed:
                parsed["user"] = json.loads(parsed["user"])
            return parsed
        return None
    except Exception as e:
        logger.error(f"initData validation error: {e}")
        return None


def extract_player_id(request: Request) -> int:
    """Extract and validate player ID from request headers."""
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    if init_data:
        validated = validate_init_data(init_data)
        if validated and "user" in validated:
            return validated["user"]["id"]

    # Fallback: trust the header during development
    player_id = request.headers.get("X-Player-Id", "")
    if player_id:
        return int(player_id)

    raise HTTPException(status_code=401, detail="Unauthorized")


# --- REST API ---

@app.get("/api/game/{game_id}")
async def get_game_state(game_id: str, request: Request):
    """Get current game state for a player."""
    player_id = extract_player_id(request)
    state = game_manager.get_game_state(game_id, for_player_id=player_id)
    if not state:
        raise HTTPException(status_code=404, detail="Game not found")
    return JSONResponse(state)


@app.get("/api/game/{game_id}/moves")
async def get_valid_moves(game_id: str, request: Request):
    """Get valid moves for the current player."""
    player_id = extract_player_id(request)
    moves = game_manager.get_valid_moves(game_id, player_id)
    return JSONResponse({"moves": moves})


@app.post("/api/game/{game_id}/move")
async def play_move(game_id: str, request: Request):
    """Play a tile."""
    player_id = extract_player_id(request)
    body = await request.json()
    tile = body.get("tile")
    side = body.get("side")

    if not tile or not side:
        raise HTTPException(status_code=400, detail="Missing tile or side")

    result = game_manager.play_move(game_id, player_id, tile, side)

    if result.get("success"):
        # Broadcast updated state to all players
        await _broadcast_state(game_id)

        # Check if game is over
        if result.get("game_over"):
            game_manager.cancel_turn_timer(game_id)
            await _handle_game_over(game_id)
        else:
            # Restart turn timer for the next player and trigger bot turns
            game_manager.start_turn_timer(game_id)
            await _trigger_bot_turns(game_id)

    return JSONResponse(result)


@app.post("/api/game/{game_id}/pass")
async def pass_turn(game_id: str, request: Request):
    """Pass the turn."""
    player_id = extract_player_id(request)
    result = game_manager.pass_move(game_id, player_id)

    if result.get("success"):
        await _broadcast_state(game_id)

        if result.get("game_over"):
            game_manager.cancel_turn_timer(game_id)
            await _handle_game_over(game_id)
        else:
            game_manager.start_turn_timer(game_id)
            await _trigger_bot_turns(game_id)

    return JSONResponse(result)


@app.post("/api/game/{game_id}/draw")
async def draw_tile(game_id: str, request: Request):
    """Draw a tile from the boneyard."""
    player_id = extract_player_id(request)
    result = game_manager.draw_tile(game_id, player_id)

    if result.get("success"):
        # Restart turn timer (player still has the turn, but gets more time after drawing)
        game_manager.start_turn_timer(game_id)
        # Broadcast updated state (other players see tile count change + boneyard count)
        await _broadcast_state(game_id)

    return JSONResponse(result)


async def _broadcast_state(game_id: str):
    """Broadcast personalized game state to all connected players."""
    await ws_manager.broadcast_game_state(
        game_id,
        lambda pid: game_manager.get_game_state(game_id, for_player_id=pid),
    )


async def _trigger_bot_turns(game_id: str):
    """If the current player is a bot, schedule their auto-play."""
    session = game_manager.get_session(game_id)
    if not session or not session.engine:
        return
    if session.engine.state.status != "active":
        return
    current = session.engine.state.current_player
    if is_bot_player(current.telegram_id):
        asyncio.create_task(maybe_play_bot_turns(game_id, _broadcast_state, _handle_game_over))


async def _handle_game_over(game_id: str):
    """Handle game over: notify players, start next game or end session."""
    result = await game_manager.handle_game_over(game_id)

    if result["action"] == "next_game":
        # Notify about the result and new game
        await ws_manager.broadcast_event(game_id, "game_over", {
            "game_result": result["game_result"],
            "next_game": True,
            "game_number": result["game_number"],
        })

        # Brief pause then send new game state
        await asyncio.sleep(1)

        await _broadcast_state(game_id)

        # Start turn timer for the first player of the new game
        game_manager.start_turn_timer(game_id)

        # If bot goes first in the new game, trigger their turns
        await _trigger_bot_turns(game_id)

    elif result["action"] == "session_end":
        game_manager.cancel_turn_timer(game_id)
        await ws_manager.broadcast_event(game_id, "session_end", {
            "results": result["results"],
        })

        # Save results to database
        from bot.db_ops import save_game_results
        await save_game_results(result["group_id"], result["results"])

        # Notify the Telegram group
        if game_manager._on_session_end:
            await game_manager._on_session_end(result)

        ws_manager.cleanup_game(game_id)


# --- WebSocket ---

@app.websocket("/ws/{game_id}/{player_id}")
async def websocket_endpoint(websocket: WebSocket, game_id: str, player_id: int):
    """WebSocket connection for real-time game updates."""
    await ws_manager.connect(game_id, player_id, websocket)

    # Send initial state
    state = game_manager.get_game_state(game_id, for_player_id=player_id)
    if state:
        await websocket.send_text(json.dumps({
            "type": "game_state",
            "data": state,
        }))

    try:
        while True:
            # We mostly use REST for moves, but keep the connection alive
            data = await websocket.receive_text()
            msg = json.loads(data)

            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        ws_manager.disconnect(game_id, player_id)
    except Exception as e:
        logger.error(f"WS error: {e}")
        ws_manager.disconnect(game_id, player_id)


# --- Test Mode ---

@app.post("/api/test/create")
async def create_test_game(request: Request):
    """Create a test game with bot opponents. No Telegram auth needed."""
    body = await request.json()
    player_id = body.get("player_id", 999999)
    player_name = body.get("player_name", "Test Player")
    num_bots = body.get("num_bots", 2)
    num_bots = max(2, min(4, num_bots))  # 2-4 bots (3-5 total)

    game_id = game_manager.create_test_game(player_id, player_name, num_bots)

    # Start turn timer for the first player
    game_manager.start_turn_timer(game_id)

    # If a bot goes first, trigger their turns after a short delay
    session = game_manager.get_session(game_id)
    if session and session.engine:
        current = session.engine.state.current_player
        if is_bot_player(current.telegram_id):
            # Delay bot start to let the client connect WebSocket first
            async def delayed_bot_start():
                await asyncio.sleep(2)
                await _trigger_bot_turns(game_id)
            asyncio.create_task(delayed_bot_start())

    return JSONResponse({"game_id": game_id, "player_id": player_id})


@app.get("/test")
async def serve_test_page():
    """Serve the test mode page."""
    return FileResponse(FRONTEND_DIR / "test.html")


# --- Static files ---

@app.get("/")
async def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")


# Mount static files AFTER specific routes
app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
