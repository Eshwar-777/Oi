"""Email sender — delivers formatted emails via Gmail SMTP.

Uses aiosmtplib for non-blocking sends in the async pipeline.
Supports plain-text and HTML content with a clean, modern template.
"""
from __future__ import annotations

import logging
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)


def _build_news_html(articles: list[dict[str, Any]], topic: str) -> str:
    """Build a clean, mobile-friendly HTML email from news articles."""
    now = datetime.utcnow().strftime("%B %d, %Y at %H:%M UTC")
    article_blocks = []

    for i, art in enumerate(articles, 1):
        source = art.get("source", "")
        source_line = f'<span style="color:#888;font-size:13px;">{source}</span>' if source else ""
        url = art.get("url", "")
        title = art.get("title", "Untitled")
        title_html = f'<a href="{url}" style="color:#1a73e8;text-decoration:none;">{title}</a>' if url else title

        article_blocks.append(f"""
        <tr><td style="padding:16px 0;border-bottom:1px solid #eee;">
            <div style="font-size:16px;font-weight:600;line-height:1.4;">{i}. {title_html}</div>
            <div style="font-size:14px;color:#444;margin-top:6px;line-height:1.5;">{art.get("snippet", "")}</div>
            <div style="margin-top:4px;">{source_line}</div>
        </td></tr>""")

    articles_html = "\n".join(article_blocks)

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <tr><td style="background:linear-gradient(135deg,#1a73e8,#4285f4);padding:24px 24px 20px;">
        <div style="color:#fff;font-size:22px;font-weight:700;">Your {topic} Digest</div>
        <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px;">{now}</div>
    </td></tr>
    <tr><td style="padding:8px 24px 24px;">
        <table width="100%" cellpadding="0" cellspacing="0">
            {articles_html}
        </table>
    </td></tr>
    <tr><td style="padding:16px 24px;background:#f9f9f9;text-align:center;">
        <div style="color:#888;font-size:12px;">Sent by Oi — your personal automation assistant</div>
    </td></tr>
</table>
</body></html>"""


async def send_email(
    to: str,
    subject: str,
    body_text: str,
    body_html: str | None = None,
) -> dict[str, Any]:
    """Send an email through Gmail SMTP. Returns send result metadata."""
    import aiosmtplib

    if not settings.smtp_user or not settings.smtp_password:
        msg = "SMTP credentials not configured (set SMTP_USER and SMTP_PASSWORD env vars)"
        logger.error(msg)
        return {"success": False, "error": msg}

    from_addr = settings.default_from_email or settings.smtp_user

    message = MIMEMultipart("alternative")
    message["From"] = f"Oi Assistant <{from_addr}>"
    message["To"] = to
    message["Subject"] = subject

    message.attach(MIMEText(body_text, "plain"))
    if body_html:
        message.attach(MIMEText(body_html, "html"))

    try:
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            start_tls=True,
            username=settings.smtp_user,
            password=settings.smtp_password,
        )
        logger.info("Email sent to %s: %s", to, subject)
        return {"success": True, "to": to, "subject": subject}

    except Exception as exc:
        logger.error("Failed to send email to %s: %s", to, exc)
        return {"success": False, "to": to, "error": str(exc)}


async def send_news_digest(
    to: str,
    topic: str,
    articles: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compose and send a formatted news digest email."""
    subject = f"Your {topic} digest — {datetime.utcnow().strftime('%b %d, %Y')}"

    text_lines = [f"Your {topic} Digest\n{'='*40}\n"]
    for i, art in enumerate(articles, 1):
        text_lines.append(f"{i}. {art.get('title', 'Untitled')}")
        text_lines.append(f"   {art.get('snippet', '')}")
        if art.get("url"):
            text_lines.append(f"   {art['url']}")
        text_lines.append("")

    body_text = "\n".join(text_lines)
    body_html = _build_news_html(articles, topic)

    return await send_email(to, subject, body_text, body_html)
