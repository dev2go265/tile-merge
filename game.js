/* Tile Merge — 2048 puzzle. Plain JS, no dependencies.
   Core logic is pure and exported for node smoke tests; DOM wiring runs
   only when `document` exists. */
(function () {
  "use strict";

  var SIZE = 4;
  var WIN_VALUE = 2048;

  /* ---------- pure core logic (testable in node) ---------- */

  // Slide one line (array of 4 values, 0 = empty) toward index 0.
  // Returns { line: [v,v,v,v], gained: score, moved: bool }.
  function slideLine(line) {
    var tiles = line.filter(function (v) { return v !== 0; });
    var out = [0, 0, 0, 0];
    var gained = 0;
    var i = 0, j = 0;
    while (i < tiles.length) {
      if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
        out[j] = tiles[i] * 2;
        gained += out[j];
        i += 2;
      } else {
        out[j] = tiles[i];
        i += 1;
      }
      j += 1;
    }
    var moved = out.some(function (v, k) { return v !== line[k]; });
    return { line: out, gained: gained, moved: moved };
  }

  // Move a 4x4 value grid. dir: 'up' | 'down' | 'left' | 'right'.
  // Returns { grid, moved, gained }.
  function moveGrid(grid, dir) {
    var next = grid.map(function (row) { return row.slice(); });
    var gained = 0, moved = false;
    var r, c, res;
    if (dir === "left" || dir === "right") {
      for (r = 0; r < SIZE; r++) {
        var line = next[r].slice();
        if (dir === "right") line.reverse();
        res = slideLine(line);
        if (dir === "right") res.line.reverse();
        next[r] = res.line;
        gained += res.gained; moved = moved || res.moved;
      }
    } else {
      for (c = 0; c < SIZE; c++) {
        var col = [next[0][c], next[1][c], next[2][c], next[3][c]];
        if (dir === "down") col.reverse();
        res = slideLine(col);
        if (dir === "down") res.line.reverse();
        for (r = 0; r < SIZE; r++) next[r][c] = res.line[r];
        gained += res.gained; moved = moved || res.moved;
      }
    }
    return { grid: next, moved: moved, gained: gained };
  }

  function hasMoves(grid) {
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (grid[r][c] === 0) return true;
        if (c + 1 < SIZE && grid[r][c] === grid[r][c + 1]) return true;
        if (r + 1 < SIZE && grid[r][c] === grid[r + 1][c]) return true;
      }
    }
    return false;
  }

  function hasWon(grid) {
    for (var r = 0; r < SIZE; r++)
      for (var c = 0; c < SIZE; c++)
        if (grid[r][c] >= WIN_VALUE) return true;
    return false;
  }

  function randomTileValue() { return Math.random() < 0.9 ? 2 : 4; }

  // Node export for smoke tests.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { slideLine: slideLine, moveGrid: moveGrid, hasMoves: hasMoves, hasWon: hasWon, SIZE: SIZE };
  }

  /* ---------- DOM game (browser only) ---------- */
  if (typeof document === "undefined") return;

  var $ = function (id) { return document.getElementById(id); };
  var tilesEl = $("tiles");
  var boardEl = $("board");

  var grid = [];            // 4x4 of tile objects {id, value, r, c} or null
  var nextId = 1;
  var score = 0, best = 0, over = false, wonShown = false, keepPlaying = false;
  var animating = false, soundOn = true;
  var prevSnapshot = null; // for undo: {values, score}
  var audioCtx = null;

  try { best = parseInt(localStorage.getItem("tile-merge-best") || "0", 10) || 0; } catch (e) { best = 0; }

  /* ---------- sound (WebAudio only) ---------- */
  function beep(freq, dur, type, vol) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.12, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) { /* audio unavailable — silent */ }
  }
  function sfxMove() { beep(180, 0.06, "triangle", 0.06); }
  function sfxMerge(v) { beep(280 + Math.min(9, Math.log2(v)) * 60, 0.12, "sine", 0.14); }
  function sfxWin() { [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { beep(f, 0.18, "sine", 0.15); }, i * 110); }); }
  function sfxLose() { beep(160, 0.35, "sawtooth", 0.08); }

  /* ---------- rendering ---------- */
  // Build the 16 background cells once.
  var cellsEl = boardEl.querySelector(".cells");
  for (var i = 0; i < 16; i++) {
    var d = document.createElement("div");
    d.className = "cell-bg";
    cellsEl.appendChild(d);
  }

  function cellSize() {
    var inner = tilesEl.clientWidth;
    return (inner - 3 * 8) / 4;
  }
  function pos(r, c) {
    var s = cellSize();
    return { x: c * (s + 8), y: r * (s + 8), s: s };
  }

  function tileEl(tile) {
    var el = document.createElement("div");
    el.className = "tile t" + tile.value;
    el.dataset.id = tile.id;
    el.textContent = tile.value;
    var p = pos(tile.r, tile.c);
    el.style.width = p.s + "px";
    el.style.height = p.s + "px";
    el.style.transform = "translate(" + p.x + "px," + p.y + "px)";
    return el;
  }

  function renderAll() {
    tilesEl.innerHTML = "";
    for (var r = 0; r < SIZE; r++)
      for (var c = 0; c < SIZE; c++)
        if (grid[r][c]) tilesEl.appendChild(tileEl(grid[r][c]));
  }

  function layoutTiles() { // reposition on resize without animation jump
    var els = tilesEl.children;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var tile = findTile(+el.dataset.id);
      if (!tile) continue;
      var p = pos(tile.r, tile.c);
      el.style.width = p.s + "px";
      el.style.height = p.s + "px";
      el.style.transform = "translate(" + p.x + "px," + p.y + "px)";
    }
  }
  function findTile(id) {
    for (var r = 0; r < SIZE; r++)
      for (var c = 0; c < SIZE; c++)
        if (grid[r][c] && grid[r][c].id === id) return grid[r][c];
    return null;
  }

  function updateScores() {
    $("score").textContent = score;
    $("best").textContent = best;
    $("title-best").textContent = best;
    if (score > best) {
      best = score;
      try { localStorage.setItem("tile-merge-best", String(best)); } catch (e) {}
      $("best").textContent = best;
    }
  }
  function bumpScore() {
    var el = $("score");
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  }

  /* ---------- game flow ---------- */
  function emptyCells() {
    var out = [];
    for (var r = 0; r < SIZE; r++)
      for (var c = 0; c < SIZE; c++)
        if (!grid[r][c]) out.push([r, c]);
    return out;
  }

  function spawnTile(animate) {
    var cells = emptyCells();
    if (!cells.length) return null;
    var pick = cells[Math.floor(Math.random() * cells.length)];
    var tile = { id: nextId++, value: randomTileValue(), r: pick[0], c: pick[1] };
    grid[pick[0]][pick[1]] = tile;
    var el = tileEl(tile);
    if (animate) el.classList.add("new");
    tilesEl.appendChild(el);
    return tile;
  }

  function newGame() {
    grid = [];
    for (var r = 0; r < SIZE; r++) { grid.push([null, null, null, null]); }
    score = 0; over = false; wonShown = false; keepPlaying = false; prevSnapshot = null;
    $("win-overlay").classList.add("hidden");
    $("lose-overlay").classList.add("hidden");
    tilesEl.innerHTML = "";
    spawnTile(false);
    spawnTile(false);
    updateScores();
  }

  function snapshot() {
    return {
      values: grid.map(function (row) { return row.map(function (t) { return t ? t.value : 0; }); }),
      score: score
    };
  }
  function restore(snap) {
    grid = [];
    for (var r = 0; r < SIZE; r++) {
      grid.push([null, null, null, null]);
      for (var c = 0; c < SIZE; c++) {
        if (snap.values[r][c]) grid[r][c] = { id: nextId++, value: snap.values[r][c], r: r, c: c };
      }
    }
    score = snap.score; over = false;
    $("win-overlay").classList.add("hidden");
    $("lose-overlay").classList.add("hidden");
    renderAll();
    updateScores();
  }

  function valuesGrid() {
    return grid.map(function (row) { return row.map(function (t) { return t ? t.value : 0; }); });
  }

  function move(dir) {
    if (animating || over) return;
    var before = valuesGrid();
    var res = moveGrid(before, dir);
    if (!res.moved) return;
    animating = true;
    prevSnapshot = snapshot();

    // Animate: slide every tile to its destination, then resolve merges.
    // Build destination map from the pure result by pairing tiles in order.
    var dest = computeDestinations(before, res.grid, dir);
    dest.forEach(function (d) {
      var el = tilesEl.querySelector('[data-id="' + d.tile.id + '"]');
      if (el) {
        var p = pos(d.toR, d.toC);
        el.style.transform = "translate(" + p.x + "px," + p.y + "px)";
      }
    });
    sfxMove();

    setTimeout(function () {
      // Apply merged values: rebuild grid from res.grid, reusing survivor tiles.
      var newGrid = [];
      for (var r = 0; r < SIZE; r++) { newGrid.push([null, null, null, null]); }
      var mergedIds = {};
      dest.forEach(function (d) {
        if (d.merge) {
          // survivor keeps its id, takes the doubled value
          d.tile.value = res.grid[d.toR][d.toC];
          d.tile.r = d.toR; d.tile.c = d.toC;
          newGrid[d.toR][d.toC] = d.tile;
          mergedIds[d.tile.id] = true;
        } else if (!d.consumed) {
          d.tile.r = d.toR; d.tile.c = d.toC;
          newGrid[d.toR][d.toC] = d.tile;
        }
      });
      grid = newGrid;
      score += res.gained;
      updateScores();
      if (res.gained > 0) { bumpScore(); sfxMerge(res.gained); }
      renderAll();
      // pop animation on merged tiles
      Object.keys(mergedIds).forEach(function (id) {
        var el = tilesEl.querySelector('[data-id="' + id + '"]');
        if (el) el.classList.add("merged");
      });
      spawnTile(true);
      animating = false;
      checkEnd();
    }, 130);
  }

  // Pair each existing tile with its destination in the result grid.
  // Returns [{tile, toR, toC, merge, consumed}].
  function computeDestinations(before, after, dir) {
    var out = [];
    var lines = [];
    if (dir === "left" || dir === "right") {
      for (var r = 0; r < SIZE; r++) lines.push({ cells: [[r, 0], [r, 1], [r, 2], [r, 3]], dir: dir });
    } else {
      for (var c = 0; c < SIZE; c++) lines.push({ cells: [[0, c], [1, c], [2, c], [3, c]], dir: dir });
    }
    lines.forEach(function (ln) {
      var cells = ln.cells.slice();
      var forward = (ln.dir === "left" || ln.dir === "up");
      if (!forward) cells.reverse();
      // source tiles in slide order
      var src = cells.map(function (rc) { return grid[rc[0]][rc[1]]; }).filter(Boolean);
      // destination values in slide order
      var dstCells = cells.filter(function (rc) { return after[rc[0]][rc[1]] !== 0; });
      var si = 0;
      dstCells.forEach(function (rc) {
        var val = after[rc[0]][rc[1]];
        var first = src[si++];
        if (first && first.value === val) {
          out.push({ tile: first, toR: rc[0], toC: rc[1], merge: false, consumed: false });
        } else if (first) {
          // merge: first tile is the survivor, second is consumed into it
          var second = src[si++];
          out.push({ tile: first, toR: rc[0], toC: rc[1], merge: true, consumed: false });
          if (second) out.push({ tile: second, toR: rc[0], toC: rc[1], merge: false, consumed: true });
        }
      });
    });
    return out;
  }

  function checkEnd() {
    if (!wonShown && !keepPlaying && hasWon(valuesGrid())) {
      wonShown = true;
      $("win-score").textContent = score;
      $("win-overlay").classList.remove("hidden");
      sfxWin();
      return;
    }
    if (!hasMoves(valuesGrid())) {
      over = true;
      $("lose-score").textContent = score;
      $("lose-best").textContent = best;
      $("lose-overlay").classList.remove("hidden");
      sfxLose();
    }
  }

  /* ---------- input ---------- */
  var KEYMAP = {
    ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
    ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right"
  };
  document.addEventListener("keydown", function (e) {
    if (e.code === "KeyR") { newGame(); return; }
    var dir = KEYMAP[e.code];
    if (dir) { e.preventDefault(); move(dir); }
  });

  // touch swipe on the board
  var tsX = 0, tsY = 0;
  boardEl.addEventListener("touchstart", function (e) {
    tsX = e.touches[0].clientX; tsY = e.touches[0].clientY;
  }, { passive: true });
  boardEl.addEventListener("touchend", function (e) {
    var dx = e.changedTouches[0].clientX - tsX;
    var dy = e.changedTouches[0].clientY - tsY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
  }, { passive: true });

  // on-screen d-pad
  document.querySelectorAll(".pad-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { move(btn.dataset.dir); });
  });

  /* ---------- buttons ---------- */
  $("start-btn").addEventListener("click", function () {
    $("title-screen").classList.add("hidden");
    $("game-screen").classList.remove("hidden");
    newGame();
  });
  $("new-game-btn").addEventListener("click", newGame);
  $("undo-btn").addEventListener("click", function () {
    if (prevSnapshot && !animating) { restore(prevSnapshot); prevSnapshot = null; }
  });
  $("sound-btn").addEventListener("click", function () {
    soundOn = !soundOn;
    $("sound-btn").textContent = soundOn ? "🔊" : "🔇";
  });
  $("keep-playing-btn").addEventListener("click", function () {
    keepPlaying = true;
    $("win-overlay").classList.add("hidden");
  });
  $("win-new-game-btn").addEventListener("click", newGame);
  $("lose-new-game-btn").addEventListener("click", newGame);

  window.addEventListener("resize", layoutTiles);

  // init: title screen, best score shown
  updateScores();
})();
