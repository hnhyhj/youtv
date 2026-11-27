# 生成每日赛事列表 daily.json
#
# 做法：
# 1. 读 events.json（赛事日历）
# 2. 找出今天正在进行、或者刚结束两天内的赛事
# 3. 去这些赛事的官方 YouTube 频道读“最新视频清单”（RSS，最近 15 个视频）
# 4. 留下标题里有赛事名称、并且是集锦或全场回放的视频
# 5. 没有正在进行的赛事时，改为各官方频道最近两天的集锦
#
# 只用 Python 自带的库，不需要 API key。

import json
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id="
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
}
MAX_ITEMS = 40          # 列表最多放多少个视频
DAYS_AFTER_END = 2      # 赛事结束后还保留几天
FALLBACK_HOURS = 72     # 没有赛事时，取最近多少小时的视频
FALLBACK_PER_CHANNEL = 6


def read_channel(channel_id):
    """读一个频道的最新视频清单，返回 [{id, title, published, is_short}]"""
    req = urllib.request.Request(RSS_URL + channel_id, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        root = ET.fromstring(resp.read())
    videos = []
    for entry in root.findall("atom:entry", NS):
        vid = entry.find("yt:videoId", NS).text
        title = entry.find("atom:title", NS).text or ""
        published = entry.find("atom:published", NS).text
        link = entry.find("atom:link", NS).get("href", "")
        videos.append({
            "id": vid,
            "title": title,
            "published": published,
            "is_short": "/shorts/" in link,
        })
    return videos


def has_any(text, words):
    text = text.lower()
    for w in words:
        if w.lower() in text:
            return True
    return False


def looks_like_match(title, words):
    """是集锦或全场回放，不是采访、花絮、短视频"""
    if has_any(title, words["exclude_any"]):
        return False
    return has_any(title, words["include_any"])


def same_game_key(title):
    """同一场比赛的普通版和加长版，去掉 EXTENDED 字样后标题一样"""
    t = title.lower()
    t = t.replace("extended:", "").replace("extended", "")
    return " ".join(t.split())


def kind_of(title):
    t = title.lower()
    if "full match" in t or ("full game" in t and "highlights" not in t):
        return "全场"
    return "集锦"


def main():
    with open("events.json", encoding="utf-8") as f:
        cal = json.load(f)
    words = cal["words"]
    now = datetime.now(timezone.utc)
    today = now.date()

    cache = {}

    def channel_videos(cid):
        if cid not in cache:
            try:
                cache[cid] = read_channel(cid)
            except Exception as e:
                print("读取频道失败", cid, e)
                cache[cid] = []
        return cache[cid]

    items = []
    seen = set()      # 已经收进来的视频 ID
    games = set()     # 已经收进来的比赛（同一场只留一个版本）
    active = []

    # 正在进行（或刚结束两天内）的赛事
    for ev in cal["events"]:
        start = datetime.strptime(ev["start"], "%Y-%m-%d").date()
        end = datetime.strptime(ev["end"], "%Y-%m-%d").date()
        if not (start <= today <= end + timedelta(days=DAYS_AFTER_END)):
            continue
        active.append(ev["name_zh"])
        for cid in ev["channels"]:
            for v in channel_videos(cid):
                if v["id"] in seen or v["is_short"]:
                    continue
                if not has_any(v["title"], ev["match_any"]):
                    continue
                if not looks_like_match(v["title"], words):
                    continue
                # 只要赛事开始以后上传的
                pub = datetime.fromisoformat(v["published"].replace("Z", "+00:00"))
                if pub.date() < start:
                    continue
                key = same_game_key(v["title"])
                if key in games:
                    continue
                games.add(key)
                seen.add(v["id"])
                items.append({
                    "id": v["id"],
                    "title": v["title"],
                    "sport": ev["sport"],
                    "event": ev["name_zh"],
                    "kind": kind_of(v["title"]),
                    "published": v["published"],
                })

    # 没有赛事视频时：各官方频道最近两天的集锦
    if len(items) == 0:
        since = now - timedelta(hours=FALLBACK_HOURS)
        for d in cal["defaults"]:
            count = 0
            for v in channel_videos(d["channel"]):
                if count >= FALLBACK_PER_CHANNEL:
                    break
                if v["id"] in seen or v["is_short"]:
                    continue
                pub = datetime.fromisoformat(v["published"].replace("Z", "+00:00"))
                if pub < since:
                    continue
                if has_any(v["title"], words["exclude_any"]):
                    continue
                if not has_any(v["title"], d["include_any"]):
                    continue
                key = same_game_key(v["title"])
                if key in games:
                    continue
                games.add(key)
                seen.add(v["id"])
                count = count + 1
                items.append({
                    "id": v["id"],
                    "title": v["title"],
                    "sport": d["sport"],
                    "event": d["channel_name"] + " 最新集锦",
                    "kind": kind_of(v["title"]),
                    "published": v["published"],
                })

    # 最新的排在前面
    items.sort(key=lambda x: x["published"], reverse=True)
    items = items[:MAX_ITEMS]

    out = {
        "date": today.isoformat(),
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "events": active,
        "items": items,
    }
    # 视频和赛事都没变，就不改文件，免得每 6 小时都多一条没意义的提交
    try:
        with open("daily.json", encoding="utf-8") as f:
            old = json.load(f)
        if old.get("items") == items and old.get("events") == active:
            print("列表没有变化")
            return
    except (OSError, ValueError):
        pass
    with open("daily.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("赛事：", active, "视频数：", len(items))


if __name__ == "__main__":
    main()
