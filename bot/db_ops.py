"""
Database operations for game history and scores.
"""

import logging
from datetime import datetime, timezone
from sqlalchemy import select, func, case, text
from bot.models import async_session_factory, Game, Session, Player, init_db

logger = logging.getLogger(__name__)


async def ensure_player(telegram_id: int, group_id: int, display_name: str, username: str = None):
    """Ensure a player record exists."""
    async with async_session_factory() as session:
        result = await session.execute(
            select(Player).where(
                Player.telegram_id == telegram_id,
                Player.group_id == group_id,
            )
        )
        player = result.scalar_one_or_none()
        if not player:
            player = Player(
                telegram_id=telegram_id,
                group_id=group_id,
                display_name=display_name,
                username=username,
            )
            session.add(player)
        else:
            player.display_name = display_name
            player.username = username
        await session.commit()


async def save_game_results(group_id: int, results: list[dict]):
    """
    Save game results for a completed session.
    results: [{"game_number": 1, "winner_telegram_id": int|None, "is_fish": bool}, ...]
    """
    async with async_session_factory() as session:
        db_session = Session(group_id=group_id, status="finished", finished_at=datetime.now(timezone.utc))
        session.add(db_session)
        await session.flush()

        for r in results:
            game = Game(
                session_id=db_session.id,
                group_id=group_id,
                game_number=r["game_number"],
                status="finished",
                winner_telegram_id=r.get("winner_telegram_id"),
                is_fish=r.get("is_fish", False),
                finished_at=datetime.now(timezone.utc),
            )
            session.add(game)

        await session.commit()
        logger.info(f"Saved session results for group {group_id}: {results}")


async def get_leaderboard(group_id: int) -> list[dict]:
    """
    Get the leaderboard for a group.
    Returns list of {"display_name": str, "wins": int, "is_fish": bool} sorted by wins desc.
    """
    async with async_session_factory() as session:
        # Count wins per player
        result = await session.execute(
            select(
                Game.winner_telegram_id,
                Game.is_fish,
                func.count().label("wins"),
            )
            .where(Game.group_id == group_id, Game.status == "finished")
            .group_by(Game.winner_telegram_id, Game.is_fish)
            .order_by(func.count().desc())
        )
        rows = result.all()

        leaderboard = []

        for row in rows:
            winner_id, is_fish, wins = row

            if is_fish:
                leaderboard.append({
                    "display_name": "Fish",
                    "wins": wins,
                    "is_fish": True,
                    "telegram_id": None,
                })
            elif winner_id:
                # Look up player name
                player_result = await session.execute(
                    select(Player).where(
                        Player.telegram_id == winner_id,
                        Player.group_id == group_id,
                    )
                )
                player = player_result.scalar_one_or_none()
                name = player.display_name if player else f"Player {winner_id}"
                leaderboard.append({
                    "display_name": name,
                    "wins": wins,
                    "is_fish": False,
                    "telegram_id": winner_id,
                })

        # Sort by wins descending
        leaderboard.sort(key=lambda x: x["wins"], reverse=True)
        return leaderboard
