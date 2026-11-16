import smtplib
import time

SMTP_HOST = "10.0.0.5"
DB_PATH = "C:/Users/me/reports.db"
RECIPIENT = "team@example.com"

while True:
    with smtplib.SMTP(SMTP_HOST) as s:
        s.sendmail("bot@example.com", [RECIPIENT], open(DB_PATH).read())
    time.sleep(3600)
