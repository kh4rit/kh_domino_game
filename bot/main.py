"""
Main entry point: runs the Telegram bot and FastAPI server together in one async process.
"""

import asyncio
import logging
import signal
import sys
import os

import uvicorn

from bot.config import WEB_HOST, WEB_PORT
from bot.models import init_db
from bot.telegram_bot import create_bot_app

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# Global reference so callbacks can access the bot
bot_app = None


async def run_web_server():
    """Run the FastAPI/uvicorn server."""
    from web.server import app
    config = uvicorn.Config(
        app=app,
        host=WEB_HOST,
        port=WEB_PORT,
        log_level="info",
    )
    server = uvicorn.Server(config)
    await server.serve()


async def run_bot():
    """Run the Telegram bot with polling."""
    global bot_app
    app = create_bot_app()
    bot_app = app

    await app.initialize()
    await app.start()
    await app.updater.start_polling(drop_pending_updates=True)

    logger.info("Bot is running...")

    # Keep running until cancelled
    try:
        while True:
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        pass
    finally:
        await app.updater.stop()
        await app.stop()
        await app.shutdown()


async def main():
    """Run both the bot and web server concurrently."""
    # Initialize database
    await init_db()
    logger.info("Database initialized.")

    # Run both concurrently
    bot_task = asyncio.create_task(run_bot())
    web_task = asyncio.create_task(run_web_server())

    logger.info(f"Web server starting on {WEB_HOST}:{WEB_PORT}")
    logger.info("Bot starting...")

    try:
        await asyncio.gather(bot_task, web_task)
    except (KeyboardInterrupt, SystemExit):
        logger.info("Shutting down...")
        bot_task.cancel()
        web_task.cancel()
        await asyncio.gather(bot_task, web_task, return_exceptions=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bye!")
