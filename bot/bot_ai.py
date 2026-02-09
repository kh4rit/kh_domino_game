"""
Simple AI for bot players in test mode.
Picks a random valid move. Runs as an async background task after each human move.
"""

import asyncio
import logging
import random

from bot.game_manager import game_manager

logger = logging.getLogger(__name__)

# Set of bot telegram IDs (negative to avoid collision with real users)
BOT_IDS = {-1, -2, -3, -4}


def is_bot_player(telegram_id: int) -> bool:
    return telegram_id in BOT_IDS


async def maybe_play_bot_turns(game_id: str, broadcast_fn, handle_game_over_fn):
    """
    If the current player is a bot, play their turn after a short delay.
    Keeps playing as long as the current player is a bot.
    """
    while True:
        session = game_manager.get_session(game_id)
        if not session or not session.engine:
            return
        if session.engine.state.status != "active":
            return

        current = session.engine.state.current_player
        if not is_bot_player(current.telegram_id):
            return  # It's a human's turn now

        # Small delay to make it feel natural
        await asyncio.sleep(1.0 + random.random() * 0.5)

        # Re-check state hasn't changed
        session = game_manager.get_session(game_id)
        if not session or not session.engine:
            return
        if session.engine.state.status != "active":
            return
        current = session.engine.state.current_player
        if not is_bot_player(current.telegram_id):
            return

        bot_id = current.telegram_id
        moves = session.engine.get_valid_moves(bot_id)

        if moves:
            # Pick a move — prefer doubles and high-pip tiles
            move = _pick_best_move(moves)
            tile = move["tile"]
            side = move["side"]
            result = game_manager.play_move(game_id, bot_id, tile.to_dict(), side)
            logger.info(f"Bot {current.display_name} plays {tile} on {side}: {result}")
        else:
            result = game_manager.pass_move(game_id, bot_id)
            logger.info(f"Bot {current.display_name} passes: {result}")

        # Broadcast updated state
        if broadcast_fn:
            await broadcast_fn(game_id)

        if result.get("game_over"):
            if handle_game_over_fn:
                await handle_game_over_fn(game_id)
            return

        # Loop to check if the next player is also a bot


def _pick_best_move(moves: list[dict]) -> dict:
    """
    Simple heuristic: prefer playing doubles, then highest pip count.
    Adds a bit of randomness so it's not completely predictable.
    """
    scored = []
    for move in moves:
        tile = move["tile"]
        score = tile.left + tile.right
        if tile.is_double():
            score += 10  # Prefer playing doubles early
        score += random.random() * 3  # Some randomness
        scored.append((score, move))

    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]
