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
            # No valid moves — draw from boneyard until we can play or it's empty
            drew_playable = False
            result = {"success": False, "error": "No action taken"}
            while True:
                draw_result = game_manager.draw_tile(game_id, bot_id)
                if not draw_result.get("success"):
                    break  # Boneyard empty or error
                logger.info(f"Bot {current.display_name} draws a tile (boneyard: {draw_result['boneyard_count']})")

                # Broadcast after each draw so players see the boneyard count change
                if broadcast_fn:
                    await broadcast_fn(game_id)
                await asyncio.sleep(0.5)

                # Re-check for valid moves
                session = game_manager.get_session(game_id)
                if not session or not session.engine:
                    return
                moves = session.engine.get_valid_moves(bot_id)
                if moves:
                    move = _pick_best_move(moves)
                    tile = move["tile"]
                    side = move["side"]
                    result = game_manager.play_move(game_id, bot_id, tile.to_dict(), side)
                    logger.info(f"Bot {current.display_name} plays {tile} on {side} (after drawing): {result}")
                    drew_playable = True
                    break

            if not drew_playable:
                result = game_manager.pass_move(game_id, bot_id)
                logger.info(f"Bot {current.display_name} passes (boneyard empty): {result}")

        # Broadcast updated state
        if broadcast_fn:
            await broadcast_fn(game_id)

        if result.get("game_over"):
            if handle_game_over_fn:
                await handle_game_over_fn(game_id)
            return

        # Loop to check if the next player is also a bot


async def ai_play_for_player(game_id: str, player_telegram_id: int):
    """
    AI takeover for a timed-out human player. Plays one turn (draw + move or pass),
    then broadcasts state and triggers bot turns if needed.
    Uses deferred import to get broadcast/game_over functions from server.
    """
    from web.server import _broadcast_state, _handle_game_over, _trigger_bot_turns

    session = game_manager.get_session(game_id)
    if not session or not session.engine:
        return
    if session.engine.state.status != "active":
        return
    current = session.engine.state.current_player
    if current.telegram_id != player_telegram_id:
        return  # Turn already changed

    moves = session.engine.get_valid_moves(player_telegram_id)

    if moves:
        move = _pick_best_move(moves)
        tile = move["tile"]
        side = move["side"]
        result = game_manager.play_move(game_id, player_telegram_id, tile.to_dict(), side)
        logger.info(f"AI takeover: {current.display_name} plays {tile} on {side}: {result}")
    else:
        # Draw from boneyard until playable or empty, then pass
        drew_playable = False
        result = {"success": False, "error": "No action taken"}
        while True:
            draw_result = game_manager.draw_tile(game_id, player_telegram_id)
            if not draw_result.get("success"):
                break
            logger.info(f"AI takeover: {current.display_name} draws (boneyard: {draw_result['boneyard_count']})")
            await _broadcast_state(game_id)
            await asyncio.sleep(0.3)

            session = game_manager.get_session(game_id)
            if not session or not session.engine:
                return
            moves = session.engine.get_valid_moves(player_telegram_id)
            if moves:
                move = _pick_best_move(moves)
                tile = move["tile"]
                side = move["side"]
                result = game_manager.play_move(game_id, player_telegram_id, tile.to_dict(), side)
                logger.info(f"AI takeover: {current.display_name} plays {tile} on {side} (after draw): {result}")
                drew_playable = True
                break

        if not drew_playable:
            result = game_manager.pass_move(game_id, player_telegram_id)
            logger.info(f"AI takeover: {current.display_name} passes: {result}")

    await _broadcast_state(game_id)

    if result.get("game_over"):
        await _handle_game_over(game_id)
    else:
        # Start timer for next player and trigger bot turns if needed
        game_manager.start_turn_timer(game_id)
        await _trigger_bot_turns(game_id)


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
