#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jutsu_dl.py — качалка серий с jut.su для личного офлайн-просмотра.

Как это работает
----------------
На странице серии jut.su прячет реальные ссылки на видео в атрибутах
data-player-1080 / -720 / -480 / -360 у тега <video>. Пока запрос идёт без
авторизации, сервер подставляет туда заглушку (pixel.png). Если же зайти со
своими куками (ты залогинен, есть премиум) — там оказываются настоящие .mp4.
Скрипт берёт твои куки из браузера, читает эти атрибуты и качает нужное качество.

ВАЖНО: логин/пароль тут не нужен и нигде не хранится. Используются только
куки из браузера, где ты уже вошёл. Всё остаётся на твоей машине.

Установка
---------
    pip install requests browser_cookie3
(requests уже есть; browser_cookie3 нужен только для --browser, для --cookies не нужен)

Примеры
-------
    # одна серия (максимальное доступное качество), куки из Chrome
    python3 jutsu_dl.py https://jut.su/faairytail/season-1/episode-1.html

    # всё аниме целиком (со страницы аниме) в 1080p
    python3 jutsu_dl.py https://jut.su/faairytail/ --quality 1080

    # другой браузер / файл куки cookies.txt (Netscape формат)
    python3 jutsu_dl.py <url> --browser firefox
    python3 jutsu_dl.py <url> --cookies cookies.txt

    # только показать список серий и качества, ничего не качать
    python3 jutsu_dl.py https://jut.su/faairytail/ --list

    # ограничить диапазон серий и притормаживать между ними
    python3 jutsu_dl.py https://jut.su/faairytail/ --from 5 --to 12 --sleep 3
"""

import argparse
import os
import re
import sys
import time
from http.cookiejar import MozillaCookieJar
from urllib.parse import urljoin, urlparse

import requests

BASE = "https://jut.su"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/125.0 Safari/537.36")

DATA_PLAYER_RE = re.compile(r'data-player-(\d+)\s*=\s*"([^"]+)"')
EPISODE_HREF_RE = re.compile(r'href="(/[^"]*?/episode-\d+\.html)"')
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)
SEASON_EP_RE = re.compile(r"/season-(\d+)/episode-(\d+)\.html")
PLAIN_EP_RE = re.compile(r"/episode-(\d+)\.html")


# --------------------------------------------------------------------------- #
# Куки / сессия
# --------------------------------------------------------------------------- #
def load_cookies(args):
    """Вернуть CookieJar из файла (--cookies) или из браузера (--browser)."""
    if args.cookies:
        jar = MozillaCookieJar(args.cookies)
        jar.load(ignore_discard=True, ignore_expires=True)
        return jar
    if args.browser == "none":
        return None
    try:
        import browser_cookie3
    except ImportError:
        sys.exit(
            "Нужен модуль browser_cookie3 для чтения куки из браузера:\n"
            "    pip install browser_cookie3\n"
            "Либо экспортируй куки в cookies.txt (расширение 'Get cookies.txt "
            "LOCALLY') и запусти с  --cookies cookies.txt"
        )
    loaders = {
        "chrome": browser_cookie3.chrome,
        "firefox": browser_cookie3.firefox,
        "edge": browser_cookie3.edge,
        "safari": browser_cookie3.safari,
        "brave": browser_cookie3.brave,
        "chromium": browser_cookie3.chromium,
        "opera": browser_cookie3.opera,
        "vivaldi": browser_cookie3.vivaldi,
    }
    loader = loaders.get(args.browser)
    if loader is None:
        sys.exit(f"Неизвестный браузер: {args.browser} (см. --help)")
    try:
        return loader(domain_name="jut.su")
    except Exception as e:  # noqa: BLE001
        sys.exit(
            f"Не смог прочитать куки из {args.browser}: {e}\n"
            "На macOS браузер лучше закрыть и разрешить доступ к связке ключей, "
            "либо используй --cookies cookies.txt"
        )


def make_session(cookies):
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Accept-Language": "ru,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    })
    if cookies is not None:
        for c in cookies:
            s.cookies.set_cookie(c)
    return s


def fetch_html(session, url):
    r = session.get(url, timeout=30)
    r.raise_for_status()
    # jut.su отдаёт страницы в windows-1251
    return r.content.decode("windows-1251", "replace")


# --------------------------------------------------------------------------- #
# Парсинг страницы
# --------------------------------------------------------------------------- #
def extract_players(html):
    """{res(int): url} — только реальные mp4, заглушки pixel.png отброшены."""
    out = {}
    for res, url in DATA_PLAYER_RE.findall(html):
        if ".mp4" in url and "pixel.png" not in url:
            out[int(res)] = url
    return out


def extract_title(html):
    m = TITLE_RE.search(html)
    if not m:
        return None
    t = re.sub(r"\s+", " ", m.group(1)).strip()
    for junk in (" на Jut.su", "Смотреть "):
        t = t.replace(junk, "")
    return t.strip()


def list_episodes(html):
    """Упорядоченный список уникальных путей к сериям со страницы аниме."""
    seen = []
    for path in EPISODE_HREF_RE.findall(html):
        if path not in seen:
            seen.append(path)
    return seen


def pick_quality(players, quality):
    if not players:
        return None, None
    if quality == "max":
        r = max(players)
    elif quality == "min":
        r = min(players)
    else:
        want = int(quality)
        if want in players:
            r = want
        else:
            lower = [x for x in players if x <= want]
            r = max(lower) if lower else min(players)
    return r, players[r]


# --------------------------------------------------------------------------- #
# Имена файлов
# --------------------------------------------------------------------------- #
def dest_path(outdir, ep_url):
    """downloads/<anime>/season-N/episode-M.mp4 — зеркалим структуру сайта."""
    path = urlparse(ep_url).path.strip("/")           # faairytail/season-1/episode-1.html
    parts = path[:-5].split("/") if path.endswith(".html") else path.split("/")
    parts[-1] = parts[-1] + ".mp4"
    safe = [re.sub(r'[^\w.\-]+', "_", p) for p in parts]
    return os.path.join(outdir, *safe)


# --------------------------------------------------------------------------- #
# Скачивание
# --------------------------------------------------------------------------- #
def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}"
        n /= 1024


def download_file(session, url, dest):
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    tmp = dest + ".part"
    resume = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    headers = {"Range": f"bytes={resume}-"} if resume else {}

    with session.get(url, headers=headers, stream=True, timeout=60) as r:
        if resume and r.status_code == 200:
            resume = 0  # сервер не поддержал докачку — качаем заново
        elif r.status_code not in (200, 206):
            r.raise_for_status()

        total = int(r.headers.get("Content-Length", 0)) + resume
        done = resume
        mode = "ab" if resume else "wb"
        start = time.monotonic()
        with open(tmp, mode) as f:
            for chunk in r.iter_content(1024 * 256):
                if not chunk:
                    continue
                f.write(chunk)
                done += len(chunk)
                elapsed = time.monotonic() - start
                speed = (done - resume) / elapsed if elapsed else 0
                bar = f"{human(done):>9}"
                if total:
                    bar = f"{done * 100 / total:5.1f}%  {human(done)}/{human(total)}"
                print(f"\r    {bar}  {human(speed)}/s   ", end="", flush=True)
    print()
    os.replace(tmp, dest)


# --------------------------------------------------------------------------- #
# Обработка серии
# --------------------------------------------------------------------------- #
def handle_episode(session, url, args):
    dest = dest_path(args.out, url)
    if os.path.exists(dest) and not args.list:
        print(f"[=] уже есть: {os.path.relpath(dest, args.out)}")
        return True

    html = fetch_html(session, url)
    players = extract_players(html)
    title = extract_title(html) or url

    if not players:
        print(f"[!] {title}\n    реальных ссылок не видно — проверь, что куки взяты "
              "из браузера с активным премиум-логином и что качаешь с того же "
              "интернета/страны, где смотришь.")
        return False

    res, mp4 = pick_quality(players, args.quality)
    have = ", ".join(f"{q}p" for q in sorted(players, reverse=True))
    print(f"[>] {title}")
    print(f"    качества: {have}  ->  качаю {res}p")

    if args.list:
        print(f"    {mp4}")
        return True

    download_file(session, mp4, dest)
    print(f"[OK] {os.path.relpath(dest, args.out)}")
    return True


def is_episode_url(url):
    return bool(PLAIN_EP_RE.search(urlparse(url).path))


def episode_number(url):
    m = SEASON_EP_RE.search(url)
    if m:
        return (int(m.group(1)), int(m.group(2)))
    m = PLAIN_EP_RE.search(url)
    return (0, int(m.group(1))) if m else (0, 0)


def main():
    ap = argparse.ArgumentParser(
        description="Качалка серий jut.su для личного офлайн-просмотра.")
    ap.add_argument("url", help="ссылка на серию или на страницу аниме")
    ap.add_argument("--browser", default="chrome",
                    help="откуда брать куки: chrome|firefox|edge|safari|brave|"
                         "chromium|opera|vivaldi|none (по умолчанию chrome)")
    ap.add_argument("--cookies", metavar="FILE",
                    help="файл cookies.txt (Netscape); имеет приоритет над --browser")
    ap.add_argument("--quality", default="max",
                    help="max|min|1080|720|480|360 (по умолчанию max)")
    ap.add_argument("--out", default="downloads", help="папка для сохранения")
    ap.add_argument("--list", action="store_true",
                    help="только показать серии/качество/ссылки, не качать")
    ap.add_argument("--from", dest="ep_from", type=int, default=None,
                    help="качать начиная с этого номера серии (в пределах сезона)")
    ap.add_argument("--to", dest="ep_to", type=int, default=None,
                    help="качать до этого номера серии включительно")
    ap.add_argument("--sleep", type=float, default=1.0,
                    help="пауза в секундах между сериями (по умолчанию 1)")
    args = ap.parse_args()

    session = make_session(load_cookies(args))

    # одиночная серия
    if is_episode_url(args.url):
        ok = handle_episode(session, args.url, args)
        sys.exit(0 if ok else 1)

    # страница аниме -> список серий
    print(f"Открываю страницу аниме: {args.url}")
    index_html = fetch_html(session, args.url)
    episodes = list_episodes(index_html)
    if not episodes:
        print("Не нашёл ссылок на серии. Это точно страница аниме?")
        sys.exit(1)

    def in_range(path):
        _, ep = episode_number(path)
        if args.ep_from is not None and ep < args.ep_from:
            return False
        if args.ep_to is not None and ep > args.ep_to:
            return False
        return True

    episodes = [e for e in episodes if in_range(e)]
    print(f"Серий к обработке: {len(episodes)}\n")

    fails = 0
    for i, path in enumerate(episodes, 1):
        ep_url = urljoin(BASE, path)
        print(f"--- [{i}/{len(episodes)}] ---")
        try:
            if not handle_episode(session, ep_url, args):
                fails += 1
        except KeyboardInterrupt:
            print("\nПрервано пользователем.")
            sys.exit(130)
        except Exception as e:  # noqa: BLE001
            print(f"[!] ошибка на {path}: {e}")
            fails += 1
        if i < len(episodes) and args.sleep:
            time.sleep(args.sleep)

    print(f"\nГотово. Успешно/всего: {len(episodes) - fails}/{len(episodes)}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
