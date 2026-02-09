"""
Telegram bot handlers for the domino game.
"""

import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)
from telegram.constants import ParseMode

from bot.config import BOT_TOKEN, BASE_URL, MIN_PLAYERS, MAX_PLAYERS, GAMES_PER_SESSION
from bot.game_manager import game_manager, LobbyPlayer
from bot.db_ops import get_leaderboard, ensure_player, save_game_results

logger = logging.getLogger(__name__)


def get_base_url():
    """Get the current base URL (may be set after tunnel starts)."""
    from bot.config import BASE_URL
    import bot.config as cfg
    return cfg.BASE_URL


# --- Command Handlers ---

async def cmd_start_game(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start_game command — create a lobby."""
    if not update.effective_chat or not update.effective_user:
        return

    chat = update.effective_chat
    user = update.effective_user

    # Only work in group chats
    if chat.type not in ("group", "supergroup"):
        await update.message.reply_text("This command only works in group chats!")
        return

    display_name = user.first_name
    if user.last_name:
        display_name += f" {user.last_name}"

    creator = LobbyPlayer(
        telegram_id=user.id,
        display_name=display_name,
        username=user.username,
    )

    game_id, message = game_manager.create_lobby(chat.id, creator)
    if not game_id:
        await update.message.reply_text(message)
        return

    # Ensure player in DB
    await ensure_player(user.id, chat.id, display_name, user.username)

    # Build lobby message with buttons
    keyboard = _build_lobby_keyboard(game_id)
    lobby = game_manager.get_lobby(game_id)
    text = _build_lobby_text(lobby)

    sent = await update.message.reply_text(
        text, reply_markup=keyboard, parse_mode=ParseMode.HTML
    )

    # Store the message ID so we can update it
    lobby.message_id = sent.message_id

    # Start the 60-second timer
    game_manager.start_lobby_timer(game_id)


async def cmd_scores(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /scores command — show leaderboard."""
    if not update.effective_chat:
        return

    chat = update.effective_chat
    if chat.type not in ("group", "supergroup"):
        await update.message.reply_text("This command only works in group chats!")
        return

    leaderboard = await get_leaderboard(chat.id)

    if not leaderboard:
        await update.message.reply_text("No games played yet in this group!")
        return

    text = "<b>Leaderboard — All Time</b>\n\n"
    for i, entry in enumerate(leaderboard, 1):
        name = entry["display_name"]
        wins = entry["wins"]
        if entry["is_fish"]:
            text += f"{i}. {'Fish'} — {wins} win{'s' if wins != 1 else ''}\n"
        else:
            text += f"{i}. {name} — {wins} win{'s' if wins != 1 else ''}\n"

    await update.message.reply_text(text, parse_mode=ParseMode.HTML)


# --- Callback Query Handlers ---

async def callback_join(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle 'Join Game' button press."""
    query = update.callback_query
    await query.answer()

    if not query.data or not query.from_user:
        return

    game_id = query.data.replace("join_", "")
    user = query.from_user

    display_name = user.first_name
    if user.last_name:
        display_name += f" {user.last_name}"

    player = LobbyPlayer(
        telegram_id=user.id,
        display_name=display_name,
        username=user.username,
    )

    success, message = game_manager.join_lobby(game_id, player)

    if success:
        await ensure_player(user.id, update.effective_chat.id, display_name, user.username)

    # Update the lobby message
    lobby = game_manager.get_lobby(game_id)
    if lobby:
        text = _build_lobby_text(lobby)
        keyboard = _build_lobby_keyboard(game_id)
        try:
            await query.edit_message_text(
                text, reply_markup=keyboard, parse_mode=ParseMode.HTML
            )
        except Exception:
            pass
    else:
        # Lobby might have been started or cancelled
        await query.answer(message, show_alert=True)


async def callback_start_now(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle 'Start Now' button press."""
    query = update.callback_query

    if not query.data:
        await query.answer()
        return

    game_id = query.data.replace("start_", "")

    if not game_manager.can_start(game_id):
        await query.answer(f"Need at least {MIN_PLAYERS} players!", show_alert=True)
        return

    await query.answer()
    await _start_game_from_lobby(game_id, query.message.chat_id, context)


async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Route callback queries."""
    query = update.callback_query
    if not query or not query.data:
        return

    if query.data.startswith("join_"):
        await callback_join(update, context)
    elif query.data.startswith("start_"):
        await callback_start_now(update, context)


# --- Helper Functions ---

def _build_lobby_text(lobby) -> str:
    """Build the lobby status message."""
    player_list = "\n".join(
        f"  {i+1}. {p.display_name}" for i, p in enumerate(lobby.players)
    )
    count = len(lobby.players)
    status = ""
    if count < MIN_PLAYERS:
        need = MIN_PLAYERS - count
        status = f"\nNeed {need} more player{'s' if need > 1 else ''} to start."
    else:
        status = "\nReady to start!"

    return (
        f"<b>Domino Game Lobby</b>\n\n"
        f"Players ({count}/{MAX_PLAYERS}):\n{player_list}\n"
        f"{status}\n\n"
        f"<i>Game auto-starts in 60 seconds or when someone clicks Start.</i>"
    )


def _build_lobby_keyboard(game_id: str) -> InlineKeyboardMarkup:
    """Build lobby inline keyboard."""
    lobby = game_manager.get_lobby(game_id)
    buttons = [[InlineKeyboardButton("Join Game", callback_data=f"join_{game_id}")]]

    if lobby and len(lobby.players) >= MIN_PLAYERS:
        buttons.append(
            [InlineKeyboardButton("Start Now!", callback_data=f"start_{game_id}")]
        )

    return InlineKeyboardMarkup(buttons)


async def _start_game_from_lobby(game_id: str, chat_id: int, context: ContextTypes.DEFAULT_TYPE = None, bot=None):
    """Start a game from a lobby and send the Mini App button."""
    success, message, session = game_manager.start_game(game_id)
    if not success:
        target = context.bot if context else bot
        if target:
            await target.send_message(chat_id, message)
        return

    base_url = get_base_url()
    webapp_url = f"{base_url}/?game_id={game_id}"

    target_bot = context.bot if context else bot
    if target_bot:
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton(
                "Play Domino!",
                web_app=WebAppInfo(url=webapp_url),
            )]
        ])

        await target_bot.send_message(
            chat_id,
            f"<b>Game Started!</b>\n\n{message}\n\n"
            f"Session: {GAMES_PER_SESSION} games\n"
            f"Click below to play:",
            reply_markup=keyboard,
            parse_mode=ParseMode.HTML,
        )


# --- Lobby Timeout Callback ---

async def on_lobby_timeout(game_id: str, action: str):
    """Called when the lobby timer expires."""
    lobby = game_manager.get_lobby(game_id)
    if not lobby:
        return

    if action == "start":
        # Auto-start the game
        from bot.main import bot_app
        if bot_app:
            await _start_game_from_lobby(game_id, lobby.group_id, bot=bot_app.bot)
    elif action == "cancel":
        from bot.main import bot_app
        if bot_app:
            await bot_app.bot.send_message(
                lobby.group_id,
                "Game lobby cancelled — not enough players joined.",
            )


# --- Session End Callback ---

async def on_session_end(result: dict):
    """Called when a game session (2 games) finishes. Posts results to group."""
    from bot.main import bot_app
    if not bot_app:
        return

    group_id = result["group_id"]
    results = result["results"]

    player_infos = result.get("player_infos", [])

    text = "<b>Session Complete!</b>\n\n"
    for r in results:
        game_num = r["game_number"]
        if r["is_fish"]:
            text += f"Game {game_num}: Fish! (no winner)\n"
        elif r["winner_telegram_id"]:
            winner_name = f"Player {r['winner_telegram_id']}"
            for p in player_infos:
                if p["telegram_id"] == r["winner_telegram_id"]:
                    winner_name = p["display_name"]
                    break
            text += f"Game {game_num}: {winner_name} wins!\n"

    # Add leaderboard
    leaderboard = await get_leaderboard(group_id)
    if leaderboard:
        text += "\n<b>Updated Leaderboard:</b>\n"
        for i, entry in enumerate(leaderboard, 1):
            name = entry["display_name"]
            wins = entry["wins"]
            fish_prefix = "" if not entry["is_fish"] else ""
            text += f"{i}. {fish_prefix}{name} — {wins} win{'s' if wins != 1 else ''}\n"

    await bot_app.bot.send_message(group_id, text, parse_mode=ParseMode.HTML)


def create_bot_app() -> Application:
    """Create and configure the Telegram bot application."""
    app = Application.builder().token(BOT_TOKEN).build()

    # Commands
    app.add_handler(CommandHandler("start_game", cmd_start_game))
    app.add_handler(CommandHandler("scores", cmd_scores))

    # Callback queries
    app.add_handler(CallbackQueryHandler(callback_handler))

    # Set up game manager callbacks
    game_manager.set_callbacks(
        on_lobby_timeout=on_lobby_timeout,
        on_session_end=on_session_end,
    )

    return app
