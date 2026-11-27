{
// 频道表。all: true 表示播放全部上传（含直播回放、短视频）；否则只播普通长视频。
const BUILT_IN = [
  { name: "NBA 篮球",   sub: "NBA 官方",          id: "UCWJ2lWNubArHWmf3FIHbfcQ", all: false },
  { name: "羽毛球",     sub: "BWF TV 世界羽联",    id: "UChh-akEbUM8_6ghGVnJd6cQ", all: false },
  { name: "网球",       sub: "Tennis TV（ATP）",   id: "UCbcxFkd6B9xUU54InHv4Tig", all: false },
  { name: "奥运会",     sub: "Olympics 官方",      id: "UCTl3QQTvqHFjurroKxexy2Q", all: false }
  // FIFA 官方频道（UCpcTrCXblq78GZrTUTLWeBw）不允许在其他网站嵌入播放（错误 150），只能在 YouTube 上看，所以去掉了
];

// “今日赛事”台：内容来自仓库里的 daily.json（GitHub 自动任务每 6 小时更新）。
// kind: "videos" 表示这个台是一串视频 ID，而不是某个频道的上传列表。
const DAILY = { name: "今日赛事", sub: "正在读取…", id: "daily", kind: "videos", ids: [], all: true };

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

let custom = load("sportsTV.custom", []);
let channels = [];
let current = -1;        // 当前频道序号
let player = null;
let pending = null;      // 等待恢复的播放位置 {videoId, time}
let usingAll = false;    // 当前频道是否已退回到“全部上传”
let errorCount = 0;
let hasPlayed = false;   // 这次调台后是否已经放出过视频
let checkedNewest = false;  // 这次调台后是否已经检查过“有没有新视频”
let freshAvailable = false; // 后台检查发现了新视频，等当前视频播完就切过去
let lastVideoId = "";       // 正在播的视频 ID，用来判断是否换到了下一个视频
let blocked = load("sportsTV.blocked", []);  // 设为“不再播放”的视频 ID
let blockedSkips = 0;       // 连续跳过了几个“不再播放”的视频，防止全部被屏蔽时一直跳
const titles = load("sportsTV.titles", {});   // 视频标题缓存：视频 ID → 标题
const durations = load("sportsTV.dur", {});   // 视频时长缓存：视频 ID → 秒数（时长不会变，存下来下次直接用）
const guideLists = load("sportsTV.lists", {});   // 各台的视频列表：频道 ID → [视频 ID, ...]，存下来下次直接用

const FIXED_COUNT = BUILT_IN.length + 1;   // 自带的台（含今日赛事）个数，后面的是自己添加的

function buildChannels() {
  channels = [DAILY];
  for (let i = 0; i < BUILT_IN.length; i++) channels.push(BUILT_IN[i]);
  for (let i = 0; i < custom.length; i++) channels.push(custom[i]);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function renderList() {
  let html = "";
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const isCustom = i >= FIXED_COUNT;
    html += '<button class="ch' + (i === current ? ' on' : '') + '" data-i="' + i + '">' +
      '<span class="num">' + (i + 1) + '</span>' +
      '<span><b>' + esc(c.name) + '</b><small>' + esc(c.sub || "") + '</small></span>' +
      (isCustom ? '<span class="del" data-del="' + i + '">删除</span>' : '') +
      '</button>';
  }
  document.getElementById("list").innerHTML = '<div style="display:grid;gap:12px">' + html + '</div>';
}

// 频道 ID 是 UC 开头；把 UC 换成 UU 是“全部上传”，换成 UULF 是“只要普通长视频”
function playlistId(c, all) {
  const rest = c.id.slice(2);
  return (all ? "UU" : "UULF") + rest;
}

// pickVideoId：从节目表里点了别的台的某个节目时，直接从那个节目开始
function tune(i, pickVideoId) {
  if (channels.length === 0) return;
  if (i < 0) i = channels.length - 1;
  if (i >= channels.length) i = 0;
  current = i;
  renderList();
  document.getElementById("msg").style.display = "none";
  const c = channels[i];
  usingAll = c.all;
  errorCount = 0;
  hasPlayed = false;
  checkedNewest = false;
  freshAvailable = false;
  lastVideoId = "";
  pending = pickVideoId ? { videoId: pickVideoId, time: 0 } : load("sportsTV.pos." + c.id, null);
  save("sportsTV.lastChannel", c.id);
  blockedSkips = 0;
  renderGuide();
  if (c.kind === "videos" && c.ids.length === 0) {
    if (player) { player.destroy(); player = null; }
    setNow("今日赛事列表还没有内容，请稍后再试，或者先看别的台。");
    return;
  }
  setNow("正在调台…（如果有广告，会先播广告）");
  let startIndex = 0;
  let startSec = 0;
  if (pending) {
    const ids = c.kind === "videos" ? c.ids : (guideLists[c.id] || []);
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] === pending.videoId) {
        startIndex = k;
        startSec = pending.time > 3 ? Math.floor(pending.time) : 0;
        break;
      }
    }
  }
  makePlayer(playerSource(c, usingAll), startIndex, startSec);
  setTimeout(refreshGuide, 3000);
}

// 一个台要播的内容：频道台是播放列表 ID（字符串），今日赛事台是一串视频 ID（数组）
function playerSource(c, all) {
  if (c.kind === "videos") return c.ids;
  return playlistId(c, all);
}

// 每次换台都拆掉旧播放器、新建一个。
// 不用 loadPlaylist：在同一个播放器里换列表时，列表内容不会真正换掉，还会继续放上一个台的视频。
// startIndex / startSec：从列表的第几个视频、第几秒开始（不传就从第一个视频开头开始）
function makePlayer(source, startIndex, startSec) {
  if (player) {
    player.destroy();
    player = null;
  }
  let el = document.getElementById("player");
  if (!el) {
    el = document.createElement("div");
    el.id = "player";
    document.getElementById("screen").prepend(el);
  }
  handledVid = "";
  advancing = false;
  lastPollTime = -1;
  lastPollVid = "";
  const vars = {
    start: startSec || 0,       // 第一个视频从第几秒开始
    autoplay: 1, rel: 0, playsinline: 1,
    loop: 1                     // 播完整个列表后从头再来
  };
  const options = { playerVars: vars, events: { onStateChange: onState, onError: onError } };
  if (typeof source === "string") {
    vars.listType = "playlist";
    vars.list = source;
    vars.index = startIndex || 0;   // 从第几个视频开始
  } else {
    // 一串视频 ID：从第 startIndex 个开始，转一圈排好；第一个放在 videoId，其余放在 playlist
    const order = [];
    const s0 = startIndex || 0;
    for (let k = 0; k < source.length; k++) order.push(source[(s0 + k) % source.length]);
    options.videoId = order[0];
    vars.playlist = order.slice(1).join(",");
  }
  player = new YT.Player("player", options);
}

// 实测：广告期间，播放器状态是“还没开始”(-1)，但时间读数走的是广告的时间，视频 ID 却还是正片的。
// 所以“在播正片” = 播放器状态是“正在播放”(1)，不能只看时间有没有走。
// 除了听“开始播放”通知，还每秒检查一次状态，防止通知漏掉；每个视频只处理一次。
let handledVid = "";     // 已经处理过“开始播放”的视频 ID
let advancing = false;   // 是否正在播正片（广告期间为 false）
let lastPollTime = -1;
let lastPollVid = "";

function onState(e) {
  if (e.data !== YT.PlayerState.PLAYING) return;
  const vid = player.getVideoData().video_id;
  if (vid && vid !== handledVid) onPlaying();
}

setInterval(function () {
  if (!player || !player.getCurrentTime || !player.getVideoData || current < 0) {
    advancing = false;
    return;
  }
  const t = player.getCurrentTime();
  const vid = player.getVideoData().video_id;
  const st = player.getPlayerState ? player.getPlayerState() : -1;
  advancing = vid !== "" && st === YT.PlayerState.PLAYING;
  lastPollTime = t;
  lastPollVid = vid;
  if (advancing && vid !== handledVid) onPlaying();
}, 1000);

function onPlaying() {
  handledVid = player.getVideoData().video_id;
  hasPlayed = true;
  errorCount = 0;
  const c = channels[current];
  const data = player.getVideoData();

  // 调台后第一次放出视频：看列表最前面是不是没见过的新视频
  if (!checkedNewest) {
    checkedNewest = true;
    // 今日赛事台的播放器列表是从续看的位置转过一圈的，“最新的”要看原始列表
    const ids = c.kind === "videos" ? c.ids : (player.getPlaylist() || []);
    if (ids.length > 0) {
      const known = load("sportsTV.newest." + c.id, null);
      const hasNew = known !== null && ids[0] !== known;
      if (hasNew && pending) {
        // 有新视频，但上次的视频还没看完：先接着看完，看完再切到最新的
        freshAvailable = true;
      } else {
        save("sportsTV.newest." + c.id, ids[0]);
      }
    }
  }

  // 已经换到下一个视频，而后台发现过新视频：重建播放器，从最新的开始播
  if (freshAvailable && !pending && lastVideoId !== "" && data.video_id !== lastVideoId) {
    freshAvailable = false;
    pending = null;
    hasPlayed = false;
    checkedNewest = false;
    lastVideoId = "";
    setNow("有新视频，正在切换到最新的…");
    makePlayer(playerSource(c, usingAll));
    return;
  }
  lastVideoId = data.video_id;

  if (pending) {
    if (data.video_id === pending.videoId) {
      // 建立播放器时一般已经从上次的位置开始了；差得多（比如列表位置没对上）才再跳一次
      if (pending.time > 3 && Math.abs(player.getCurrentTime() - pending.time) > 5) {
        player.seekTo(pending.time, true);
      }
      pending = null;
    } else {
      const ids = player.getPlaylist() || [];
      let k = -1;
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === pending.videoId) { k = i; break; }
      }
      if (k === -1) {
        pending = null;
        if (freshAvailable) {
          freshAvailable = false;
          const all = c.kind === "videos" ? c.ids : ids;
          save("sportsTV.newest." + c.id, all[0]);
        }
      } else {
        player.playVideoAt(k);
      }
    }
  }

  // 设为“不再播放”的视频：自动跳过
  if (!pending && isBlocked(data.video_id)) {
    blockedSkips = blockedSkips + 1;
    if (blockedSkips < 30) {
      setNow("跳过一个设为“不再播放”的视频…");
      player.nextVideo();
      return;
    }
  }
  blockedSkips = 0;

  if (data.title) titles[data.video_id] = data.title;
  setNow(data.title);
  renderGuide();
}

// 换视频时 YouTube 常常先插广告，广告期间不会触发“正在播放”，
// 所以每 2 秒检查一次：列表位置或播放状态变了，就刷新标题和节目表。
let shownIdx = -1;
let shownPlaying = false;
setInterval(function () {
  if (!player || !player.getPlaylistIndex || !player.getPlayerState || current < 0) return;
  const idx = player.getPlaylistIndex();
  const playingNow = advancing;
  if (idx === shownIdx && playingNow === shownPlaying) return;
  shownIdx = idx;
  shownPlaying = playingNow;
  const data = player.getVideoData();
  // 广告期间播放器有时拿不到标题，就用节目表里存的标题
  const t = data ? (data.title || titles[data.video_id]) : "";
  const paused = player.getPlayerState() === YT.PlayerState.PAUSED;
  if (t) setNow(playingNow ? t : (paused ? "已暂停：" + t : "即将播放：" + t));
  renderGuide();
}, 2000);

window.addEventListener("resize", function () { renderGuide(); });

// 时间在走，红线和节目格子每 30 秒重画一次
setInterval(function () { renderGuide(); }, 30000);

function isBlocked(id) {
  for (let i = 0; i < blocked.length; i++) {
    if (blocked[i] === id) return true;
  }
  return false;
}

// ================= 节目表 =================
// 每一行是一个台，横轴是时间，格子宽度按视频时长。
// 当前正在看的台：按播放器的真实进度画；
// 其他台：画的是“现在调过去会看到什么”（有没看完的就从没看完的接着，否则从最新的开始）。

const GUIDE_BEFORE = 10 * 60;      // 红线左边显示 10 分钟
const PX_PER_MIN = 10;             // 每分钟画 10 像素，短视频的标题也能看到几个字
const DEFAULT_DUR = 10 * 60;       // 还不知道时长的视频，先按 10 分钟画

function twoDigits(n) { return n < 10 ? "0" + n : "" + n; }
function clockText(sec) {
  const d = new Date(sec * 1000);
  return twoDigits(d.getHours()) + ":" + twoDigits(d.getMinutes());
}

// 某个台从哪个视频、哪一秒开始算
function startPointFor(c, ids) {
  const pos = load("sportsTV.pos." + c.id, null);
  if (pos) {
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] === pos.videoId) return { k: k, time: pos.time };
    }
  }
  return { k: 0, time: 0 };
}

// 算出某个台在时间窗口里的节目：[{k, id, start, end}]
function rowPrograms(i, winStart, winEnd, now) {
  const c = channels[i];
  let ids, k, begin;
  if (i === current && player && player.getPlaylist && player.getPlaylist()) {
    ids = player.getPlaylist();
    k = player.getPlaylistIndex();
    if (k < 0) k = 0;
    const t = player.getCurrentTime ? player.getCurrentTime() : 0;
    begin = t > 0 ? now - t : now;
  } else {
    ids = guideLists[c.id];
    if (!ids || ids.length === 0) return null;
    const sp = startPointFor(c, ids);
    k = sp.k;
    begin = now - sp.time;
  }
  const out = [];
  let t = begin;
  for (let step = 0; step < ids.length && t < winEnd && out.length < 40; step++) {
    const kk = (k + step) % ids.length;
    const id = ids[kk];
    if (isBlocked(id)) continue;
    let d = durations[id];
    if (!d && i === current && step === 0 && player.getDuration) d = Math.round(player.getDuration());
    if (!d) d = DEFAULT_DUR;
    out.push({ k: kk, id: id, start: t, end: t + d });
    t = t + d;
  }
  return out;
}

function renderGuide() {
  const box = document.getElementById("guide");
  const titleBox = document.getElementById("guideTitle");
  if (current < 0) {
    titleBox.textContent = "节目表";
    box.innerHTML = '<p class="hint">选一个频道后，这里显示这个台接下来的节目。</p>';
    return;
  }
  titleBox.textContent = "节目表：" + channels[current].name;

  const now = Date.now() / 1000;
  // 屏幕越宽，显示的时间越长：最少 1 小时，最多 3 小时
  let minutes = Math.floor(box.clientWidth / PX_PER_MIN);
  if (minutes < 60) minutes = 60;
  if (minutes > 180) minutes = 180;
  const span = minutes * 60;
  const winStart = now - GUIDE_BEFORE;
  const winEnd = winStart + span;
  function pct(sec) { return ((sec - winStart) / span * 100).toFixed(3) + "%"; }

  // 表头：每半小时一个刻度
  let head = '<div class="g-head">';
  let tick = Math.ceil(winStart / 1800) * 1800;
  while (tick < winEnd) {
    head += '<div class="g-time" style="left:' + pct(tick) + '">' + clockText(tick) + '</div>';
    tick = tick + 1800;
  }
  head += '</div>';

  let line = '<div class="g-line">';
  const missing = [];
  const progs = rowPrograms(current, winStart, winEnd, now);
  if (!progs) {
    line += '<div class="g-wait">正在读取节目…</div>';
  } else {
    for (let j = 0; j < progs.length; j++) {
      const p = progs[j];
      const left = Math.max(p.start, winStart);
      const right = Math.min(p.end, winEnd);
      if (right <= left) continue;
      const title = titles[p.id];
      if (title === undefined) missing.push(p.id);
      const isCur = p.start <= now && now < p.end;
      line += '<button class="g-prog' + (isCur ? ' cur' : '') + '" data-k="' + p.k + '"' +
        ' style="left:' + pct(left) + ';width:calc(' + pct(right) + ' - ' + pct(left) + ' - 4px)"' +
        ' title="' + esc(title || "") + '">' +
        '<small>' + (isCur ? '正在播放' : clockText(p.start)) + '</small>' +
        '<span>' + esc(title || "…") + '</span></button>';
    }
  }
  line += '<div class="g-now" style="left:' + pct(now) + '"></div></div>';
  box.innerHTML = '<div class="g-grid">' + head + line + '</div>';
  loadTitles(missing);
}

// 向 YouTube 的公开接口要标题，拿到后刷新节目表，并存下来下次直接用
function loadTitles(ids) {
  if (ids.length === 0) return;
  let left = ids.length;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    titles[id] = "";   // 先占位，避免重复请求
    fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { titles[id] = (j && j.title) ? j.title : "（无法读取标题）"; })
      .catch(function () { titles[id] = "（无法读取标题）"; })
      .then(function () {
        left = left - 1;
        if (left === 0) {
          save("sportsTV.titles", titles);
          renderGuide();
        }
      });
  }
}

function renderBlocked() {
  const box = document.getElementById("blockedInfo");
  if (blocked.length === 0) { box.innerHTML = ""; return; }
  box.innerHTML = '已设为不再播放：' + blocked.length + ' 个视频 <button class="linkbtn" id="unblock">全部恢复</button>';
  document.getElementById("unblock").onclick = function () {
    blocked = [];
    save("sportsTV.blocked", blocked);
    renderBlocked();
    renderGuide();
  };
}

// ---------- 后台读取各台的列表和视频时长 ----------
// 做法：建一个看不见、静音、不播放的小播放器，读取当前台的列表，
// 再把要画在节目表里的视频一个个“准备”（cue）一下，读出时长。
// 顺便检查当前台有没有新视频：有的话，等当前视频播完就切到最新的。
let guideBusy = false;

function refreshGuide() {
  if (guideBusy || !window.YT || !YT.Player || current < 0) return;
  guideBusy = true;
  probeChannel(channels[current], function () {
    guideBusy = false;
    renderGuide();
  });
}

function probeChannel(c, done) {
  let box = document.getElementById("probe");
  if (!box) {
    box = document.createElement("div");
    box.id = "probe";
    document.body.appendChild(box);
  }
  const isCurrent = current >= 0 && channels[current].id === c.id;
  const isVideos = c.kind === "videos";
  if (isVideos && c.ids.length === 0) { done(); return; }
  let waiter = null;
  let finished = false;
  let tries = 0;

  const probeOptions = {
    width: 1,
    height: 1,
    playerVars: { autoplay: 0, mute: 1 },
    events: {
      onReady: function () { waitForList(); },
      onStateChange: function (e) {
        if (e.data === YT.PlayerState.CUED && waiter) {
          const w = waiter;
          waiter = null;
          w();
        }
      }
    }
  };
  if (isVideos) {
    probeOptions.videoId = c.ids[0];
  } else {
    probeOptions.playerVars.listType = "playlist";
    probeOptions.playerVars.list = playlistId(c, isCurrent ? usingAll : c.all);
  }
  const probe = new YT.Player("probe", probeOptions);

  function finish() {
    if (finished) return;
    finished = true;
    try { probe.destroy(); } catch (e) {}
    done();
  }

  function waitForList() {
    const ids = isVideos ? c.ids : (probe.getPlaylist ? probe.getPlaylist() : null);
    if (ids && ids.length > 0) {
      guideLists[c.id] = ids;
      save("sportsTV.lists", guideLists);
      checkFresh(c, ids);
      const sp = startPointFor(c, ids);
      fillDurations(ids, sp.k, 0, 0);
    } else if (tries < 15) {
      tries = tries + 1;
      setTimeout(waitForList, 1000);
    } else {
      finish();
    }
  }

  // 从起点往后，凑够 3 小时或者看了 25 个视频就停
  function fillDurations(ids, k, count, total) {
    if (count >= 25 || total >= 3 * 3600) { finish(); return; }
    const id = ids[k % ids.length];
    if (isBlocked(id)) { fillDurations(ids, k + 1, count + 1, total); return; }
    if (durations[id]) { fillDurations(ids, k + 1, count + 1, total + durations[id]); return; }

    let called = false;
    function after() {
      if (called) return;
      called = true;
      waiter = null;
      setTimeout(function () {
        if (probe.getVideoData && probe.getVideoData().video_id === id) {
          const d = Math.round(probe.getDuration());
          if (d > 0) {
            durations[id] = d;
            save("sportsTV.dur", durations);
          }
        }
        fillDurations(ids, k + 1, count + 1, total + (durations[id] || DEFAULT_DUR));
      }, 300);
    }
    waiter = after;
    setTimeout(after, 5000);   // 5 秒还没准备好就跳过这个
    probe.cueVideoById(id);
  }
}

// 当前台的列表最前面变了，说明有新视频：等当前视频播完就切过去
function checkFresh(c, ids) {
  if (current < 0 || channels[current].id !== c.id) return;
  if (!hasPlayed || freshAvailable) return;
  const known = load("sportsTV.newest." + c.id, null);
  if (known !== null && ids[0] !== known) freshAvailable = true;
}

// YouTube 播放器的程序加载好以后，先读一遍节目表；之后每 10 分钟更新一次
window.onYouTubeIframeAPIReady = function () { refreshGuide(); };
setInterval(refreshGuide, 10 * 60 * 1000);

// 有些视频不允许在外部网页播放，或在本地区不能看：自动跳到下一个
function onError(e) {
  errorCount = errorCount + 1;
  // 这个台还一个视频都没放出来就报错，可能是“只播长视频”的列表不可用，改成全部上传再试
  if (!hasPlayed && !usingAll) {
    usingAll = true;
    makePlayer(playlistId(channels[current], true));
    return;
  }
  // 一个视频都没放出来就连续报错：整个台都不允许在其他网站播放
  if (!hasPlayed && errorCount >= 3) {
    setNow("这个台的视频不允许在其他网站播放，只能去 YouTube 上看。请换一个台。");
    return;
  }
  if (errorCount < 10) {
    setNow("这个视频不能在这里播放，跳到下一个…");
    player.nextVideo();
  } else {
    setNow("这个频道连续多个视频无法播放，请换一个台。");
  }
}

function setNow(text) {
  const name = current >= 0 ? channels[current].name : "";
  document.getElementById("now").innerHTML = '<span>' + esc(name) + '</span>' + esc(text || "");
}

// 每 5 秒记一次播放位置，下次回到这个台从这里接着看
setInterval(function () {
  if (!player || current < 0 || !player.getVideoData || !player.getPlayerState) return;
  if (!hasPlayed) return;   // 新台还没放出视频时不记录，免得把上一个台的位置记到这个台名下
  if (!advancing) return;
  const data = player.getVideoData();
  if (!data || !data.video_id) return;
  save("sportsTV.pos." + channels[current].id, { videoId: data.video_id, time: Math.floor(player.getCurrentTime()) });
}, 5000);

function togglePause() {
  if (!player || !player.getPlayerState) return;
  if (advancing) player.pauseVideo();
  else player.playVideo();
}

document.getElementById("list").addEventListener("click", function (e) {
  const del = e.target.closest("[data-del]");
  if (del) {
    const i = Number(del.dataset.del);
    custom.splice(i - FIXED_COUNT, 1);
    save("sportsTV.custom", custom);
    buildChannels();
    if (current === i) current = -1;
    renderList();
    return;
  }
  const btn = e.target.closest(".ch");
  if (btn) tune(Number(btn.dataset.i));
});

document.getElementById("chDown").onclick = function () { tune(current - 1); };
document.getElementById("chUp").onclick = function () { tune(current + 1); };
document.getElementById("prev").onclick = function () { if (player && player.previousVideo) player.previousVideo(); };
document.getElementById("next").onclick = function () { if (player && player.nextVideo) player.nextVideo(); };
document.getElementById("pause").onclick = togglePause;
document.getElementById("block").onclick = function () {
  if (!player || !player.getVideoData) return;
  const id = player.getVideoData().video_id;
  if (!id) return;
  if (!isBlocked(id)) blocked.push(id);
  save("sportsTV.blocked", blocked);
  renderBlocked();
  setNow("已设为不再播放，跳到下一个…");
  player.nextVideo();
};
document.getElementById("guide").addEventListener("click", function (e) {
  const item = e.target.closest(".g-prog");
  if (!item || !player || !player.playVideoAt) return;
  pending = null;
  freshAvailable = false;   // 自己选的节目，不要被“切到最新”打断
  player.playVideoAt(Number(item.dataset.k));
});
document.getElementById("full").onclick = function () {
  const s = document.getElementById("screen");
  if (s.requestFullscreen) s.requestFullscreen().catch(function () {});
};

document.addEventListener("keydown", function (e) {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowUp") { e.preventDefault(); tune(current - 1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); tune(current + 1); }
  else if (e.key === "ArrowLeft" && player && player.previousVideo) { e.preventDefault(); player.previousVideo(); }
  else if (e.key === "ArrowRight" && player && player.nextVideo) { e.preventDefault(); player.nextVideo(); }
  else if (e.key === " ") { e.preventDefault(); togglePause(); }
});

document.getElementById("addForm").addEventListener("submit", function (e) {
  e.preventDefault();
  const name = document.getElementById("addName").value.trim();
  const id = document.getElementById("addId").value.trim();
  const msg = document.getElementById("addMsg");
  if (id.length !== 24 || id.slice(0, 2) !== "UC") {
    msg.textContent = "频道 ID 应该以 UC 开头，一共 24 个字符。";
    return;
  }
  custom.push({ name: name, sub: "自己添加", id: id, all: document.getElementById("addAll").checked });
  save("sportsTV.custom", custom);
  buildChannels();
  renderList();
  msg.textContent = "已添加：" + name;
  e.target.reset();
});

// 读取今日赛事列表
function loadDaily() {
  fetch("daily.json?t=" + Date.now())
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.items) { DAILY.sub = "列表还没生成"; renderList(); return; }
      const ids = [];
      const sports = [];
      for (let i = 0; i < d.items.length; i++) {
        const it = d.items[i];
        ids.push(it.id);
        if (it.title && !titles[it.id]) titles[it.id] = it.title;
        let have = false;
        for (let j = 0; j < sports.length; j++) { if (sports[j] === it.sport) have = true; }
        if (!have) sports.push(it.sport);
      }
      DAILY.ids = ids;
      guideLists[DAILY.id] = ids;
      if (ids.length === 0) DAILY.sub = "今天暂时没有视频";
      else DAILY.sub = ids.length + " 个视频 · " + sports.join("、");
      renderList();
      if (current >= 0 && channels[current].id === DAILY.id) renderGuide();
    })
    .catch(function () { DAILY.sub = "列表读取失败"; renderList(); });
}

buildChannels();
renderList();
renderBlocked();
renderGuide();
loadDaily();
setInterval(loadDaily, 30 * 60 * 1000);

// 打开网页时：如果上次看过某个台，显示“继续观看”大按钮。
// 浏览器一般不允许网页没被点击就自动带声音播放，所以需要点一下。
const lastId = load("sportsTV.lastChannel", null);
let lastIndex = -1;
for (let i = 0; i < channels.length; i++) {
  if (channels[i].id === lastId) { lastIndex = i; break; }
}
if (lastIndex >= 0) {
  const msgBox = document.getElementById("msg");
  msgBox.innerHTML = '<button class="resume" id="resume">▶ 继续观看：' + esc(channels[lastIndex].name) + '</button>';
  document.getElementById("resume").onclick = function () { tune(lastIndex); };
}
}
