// ---- ytmusic-remote: player helper (added for the GNOME extension) ----
// Reads and drives the player the same way pear-desktop's own renderer does
// (src/renderer.ts: peard:toggle-play, peard:update-like, ...), so no API
// server and no token are needed. The page pushes its state through the
// Runtime binding window.__ytmrPush whenever something the panel shows
// changes; the extension never polls while music plays.
(function () {
  var Y = window.__ytmr;
  if (!Y || Y.p) return;
  var q = function (s) { return document.querySelector(s); };
  var mp = function () { return q("#movie_player"); };
  var bar = function () { return q("ytmusic-player-bar"); };
  var likeEl = function () { return q("#like-button-renderer") || q("ytmusic-like-button-renderer"); };
  var artOf = function (md, vid) {
    var list = (md && md.artwork) || [];
    var best = "", bestW = 0;
    for (var i = 0; i < list.length; i++) {
      var w = parseInt(String(list[i].sizes || "0").split("x")[0], 10) || 0;
      if (list[i].src && (!best || (w <= 544 && w >= bestW))) { best = list[i].src; bestW = w; }
    }
    if (!best && vid) best = "https://i.ytimg.com/vi/" + vid + "/mqdefault.jpg";
    return best;
  };
  var snap = function () {
    var r = Y.ready();
    var out = { ready: r === true, offline: r === "offline", signedIn: Y.signedIn(), now: Date.now() };
    var p = mp(), v = q("video"), b = bar();
    if (!p) return out;
    var vd = {};
    try { vd = p.getVideoData() || {}; } catch (e) {}
    var md = navigator.mediaSession && navigator.mediaSession.metadata;
    out.videoId = vd.video_id || "";
    // mediaSession can lag one song behind right after a change; the player's
    // own data wins when the two disagree on the title.
    var mdOk = md && (!vd.title || md.title === vd.title);
    out.title = (mdOk && md.title) || vd.title || "";
    out.artist = (mdOk && md.artist) || vd.author || "";
    out.album = (mdOk && md.album) || "";
    out.art = artOf(mdOk ? md : null, out.videoId);
    var st = -1;
    try { st = p.getPlayerState(); } catch (e) {}
    out.state = typeof st === "number" ? st : -1;
    out.playing = st === 1 || (st === 3 && !!v && !v.paused);
    try { out.duration = p.getDuration() || 0; } catch (e) { out.duration = v ? (v.duration || 0) : 0; }
    try { out.t = p.getCurrentTime() || 0; } catch (e) { out.t = v ? v.currentTime : 0; }
    try { out.playlistId = (p.getPlaylistId && p.getPlaylistId()) || ""; } catch (e) { out.playlistId = ""; }
    var l = likeEl();
    out.like = l ? (l.likeStatus || l.getAttribute("like-status") || "INDIFFERENT") : "INDIFFERENT";
    out.shuffle = !!(b && b.hasAttribute("shuffle-on"));
    out.repeat = (b && (b.repeatMode || b.getAttribute("repeat-mode"))) || "NONE";
    try { out.volume = p.getVolume(); out.muted = !!p.isMuted(); } catch (e) { out.volume = 100; out.muted = false; }
    return out;
  };
  var sigOf = function (s) {
    return [s.ready, s.offline, s.signedIn, s.videoId, s.title, s.artist, s.art, Math.round(s.duration || 0),
      s.playing, s.state, s.like, s.shuffle, s.repeat, s.volume, s.muted].join("|");
  };
  var last = "";
  var lastPush = 0;
  var tick = function (force) {
    if (typeof window.__ytmrPush !== "function") return;
    var v = q("video");
    if (v && !v.__ytmrHooked) {
      v.__ytmrHooked = true;
      ["seeked", "play", "pause", "ended", "loadedmetadata"].forEach(function (e) {
        v.addEventListener(e, function () { setTimeout(function () { tick(true); }, 60); });
      });
    }
    var s;
    try { s = snap(); } catch (e) { return; }
    var g = sigOf(s);
    // A slow resync every 20 s while playing keeps the extension's clock honest.
    var stale = s.playing && Date.now() - lastPush > 20000;
    if (!force && g === last && !stale) return;
    last = g;
    lastPush = Date.now();
    try { window.__ytmrPush(JSON.stringify(s)); } catch (e) {}
  };
  var watch = function () {
    if (window.__ytmrWatch) clearInterval(window.__ytmrWatch);
    last = "";
    window.__ytmrWatch = setInterval(function () { tick(false); }, 700);
    tick(true);
    return true;
  };
  var click = function (sel) { var e = q(sel); if (e) e.click(); return !!e; };
  Y.p = {
    snap: snap,
    watch: watch,
    toggle: function () {
      var p = mp();
      if (!p) return false;
      if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo();
      return true;
    },
    play: function () { var p = mp(); if (p) p.playVideo(); return !!p; },
    pause: function () { var p = mp(); if (p) p.pauseVideo(); return !!p; },
    next: function () { return click(".next-button.ytmusic-player-bar"); },
    prev: function () { return click(".previous-button.ytmusic-player-bar"); },
    seek: function (t) { var p = mp(); if (p) p.seekTo(t, true); return !!p; },
    volume: function (v) {
      var b = bar(), p = mp();
      if (b && typeof b.updateVolume === "function") b.updateVolume(v);
      else if (p) p.setVolume(v);
      try { if (v > 0 && p && p.isMuted()) p.unMute(); } catch (e) {}
      return true;
    },
    mute: function () {
      var b = bar();
      if (b && typeof b.onVolumeClick === "function") { b.onVolumeClick(); return true; }
      var p = mp();
      if (!p) return false;
      if (p.isMuted()) p.unMute(); else p.mute();
      return true;
    },
    // kind: "LIKE" or "DISLIKE". Pressing the active one clears it, like the app.
    like: function (kind) {
      var l = likeEl();
      if (!l) return false;
      var btn = l.querySelector(kind === "LIKE" ? "#button-shape-like button" : "#button-shape-dislike button");
      if (btn) { btn.click(); return true; }
      if (typeof l.updateLikeStatus === "function") {
        var cur = l.likeStatus || l.getAttribute("like-status");
        l.updateLikeStatus(cur === kind ? "INDIFFERENT" : kind);
        return true;
      }
      return false;
    },
    shuffle: function () {
      var b = bar();
      if (b && b.queue && typeof b.queue.shuffle === "function") { b.queue.shuffle(); return true; }
      return click(".shuffle.ytmusic-player-bar");
    },
    repeat: function () {
      var b = bar();
      if (b && typeof b.onRepeatButtonClick === "function") { b.onRepeatButtonClick(); return true; }
      return click(".repeat.ytmusic-player-bar");
    },
    // Put songs into the queue the way pear-desktop's peard:add-to-queue does.
    // where: "INSERT_AFTER_CURRENT_VIDEO" (play next) or "INSERT_AT_END".
    enqueue: function (videoId, where) {
      var qe = q("#queue");
      var a = q("ytmusic-app");
      var store = qe && qe.queue && qe.queue.store && qe.queue.store.store;
      if (!a || !store) return Promise.resolve({ error: "Start a song first, then add to the queue." });
      var st = store.getState().queue;
      return a.networkManager.fetch("/music/get_queue", {
        queueContextParams: st.queueContextParams, queueInsertPosition: where, videoIds: [videoId]
      }).then(function (r) {
        var datas = (r && r.queueDatas) || [];
        var items = datas.map(function (d) { return d && d.content; }).filter(Boolean);
        if (!items.length) return { error: "YouTube Music did not add it." };
        var now = store.getState().queue;
        var list = now.items || [];
        var cur = -1;
        for (var i = 0; i < list.length; i++) {
          var w = list[i];
          var rr = w.playlistPanelVideoRenderer || (w.playlistPanelVideoWrapperRenderer && w.playlistPanelVideoWrapperRenderer.primaryRenderer.playlistPanelVideoRenderer);
          if (rr && rr.selected) { cur = i; break; }
        }
        qe.dispatch({ type: "ADD_ITEMS", payload: {
          nextQueueItemId: now.nextQueueItemId,
          index: where === "INSERT_AFTER_CURRENT_VIDEO" && cur >= 0 ? cur + 1 : list.length,
          items: items, shuffleEnabled: false, shouldAssignIds: true } });
        return { ok: true };
      }, function () { return { error: "Could not reach YouTube Music." }; });
    }
  };
})();
