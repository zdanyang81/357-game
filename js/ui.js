/**
 * 357 界面层：渲染棋盘、点选拿取、动画、走子日志、AI 回合调度
 */
(function () {
  'use strict';

  // ---- DOM 引用 ----
  const board = document.getElementById('board');
  const turnBanner = document.getElementById('turn-banner');
  const turnDot = document.getElementById('turn-dot');
  const turnText = document.getElementById('turn-text');
  const pickInfo = document.getElementById('pick-info');
  const btnConfirm = document.getElementById('btn-confirm');
  const btnCancel = document.getElementById('btn-cancel');
  const btnHint = document.getElementById('btn-hint');
  const btnReset = document.getElementById('btn-reset');
  const btnRestart = document.getElementById('btn-restart');
  const logList = document.getElementById('log-list');
  const overlay = document.getElementById('overlay');
  const resultIcon = document.getElementById('result-icon');
  const resultTitle = document.getElementById('result-title');
  const resultSub = document.getElementById('result-sub');
  const modePvp = document.getElementById('mode-pvp');
  const modeAi = document.getElementById('mode-ai');
  const aiFirstToggle = document.getElementById('ai-first-toggle');
  const aiFirstInput = document.getElementById('ai-first');
  const avatarP1Side = document.getElementById('avatar-p1-side');
  const avatarP2Side = document.getElementById('avatar-p2-side');
  const avatarP1 = document.getElementById('avatar-p1');
  const avatarP2 = document.getElementById('avatar-p2');

  // 双人模式形象集（男女各 3 个）与双方选择（索引）
  const AVATARS = ['👨‍💼', '👨‍🍳', '👨‍🚀', '👩‍💼', '👩‍🎨', '👩‍🚀'];
  const avatar = { p1: 0, p2: 3 };

  // ---- 状态 ----
  let game = G357.createGame(G357.MODE_PVP);
  let gameToken = 0;      // 局次代际：每次开新局递增，用于丢弃过期异步任务
  let selection = null;   // { row, count } 当前选中的拿取
  let hintActive = false; // 当前选择是否来自「提示」
  let busy = false;       // AI 回合 / 动画期间禁止操作

  const AI_THINK_MS = 750; // 模拟思考延迟
  const DIE_ANIM_MS = 320; // 骰子消失动画时长

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ---- 玩家显示名 ----
  function playerName(p) {
    if (game.mode === G357.MODE_AI) {
      return p === G357.PLAYER_1 ? '你' : '电脑';
    }
    return p === G357.PLAYER_1 ? '玩家1' : '玩家2';
  }

  function playerIcon(p) {
    if (game.mode === G357.MODE_AI) {
      return p === G357.PLAYER_1 ? '🙋' : '🤖';
    }
    return p === G357.PLAYER_1 ? AVATARS[avatar.p1] : AVATARS[avatar.p2];
  }

  // ---- 双人模式形象选择面板（分列棋盘左右） ----
  // 形象面板显隐：左右两个侧栏同步切换（仅双人模式显示）
  function setAvatarPanelVisible(visible) {
    avatarP1Side.classList.toggle('hidden', !visible);
    avatarP2Side.classList.toggle('hidden', !visible);
  }

  function renderAvatarPanel() {
    [avatarP1, avatarP2].forEach(function (box, i) {
      const mine = i === 0 ? avatar.p1 : avatar.p2;
      const theirs = i === 0 ? avatar.p2 : avatar.p1;
      box.innerHTML = '';
      AVATARS.forEach(function (face, idx) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-btn' + (idx === mine ? ' active' : '');
        btn.textContent = face;
        // 冲突约束：对方已选的形象本组禁用，保证双方形象永不相同
        btn.disabled = idx === theirs;
        btn.setAttribute('aria-label', '选择形象 ' + face);
        btn.setAttribute('aria-pressed', idx === mine ? 'true' : 'false');
        btn.addEventListener('click', function () {
          if (idx === theirs) return; // 防御：程序化派发时同样拦截冲突
          if (i === 0) { avatar.p1 = idx; } else { avatar.p2 = idx; }
          renderAvatarPanel();
          updateTurnBanner();
          updateControls();
        });
        box.appendChild(btn);
      });
    });
  }

  // ---- 渲染棋盘 ----
  function renderBoard() {
    board.innerHTML = '';
    game.piles.forEach(function (n, row) {
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      rowEl.dataset.row = row;
      for (let i = 0; i < n; i++) {
        const die = document.createElement('div');
        die.className = 'die';
        die.dataset.row = row;
        die.dataset.index = i;
        die.innerHTML =
          '<span class="pip"></span><span class="pip"></span><span class="pip"></span>';
        rowEl.appendChild(die);
      }
      board.appendChild(rowEl);
    });
    refreshRowHighlight();
    updateBinPanel();
  }

  // ---- 二进制分析面板：三排数量的二进制 + 异或（支持选中预览） ----
  function toBits(n) {
    // 0..7 固定 3 位二进制
    return n.toString(2).padStart(3, '0');
  }

  // 当前选中拿取后预计的局面；未选中返回 null
  function previewPiles() {
    if (!selection) return null;
    const piles = game.piles.slice();
    piles[selection.row] -= selection.count;
    return piles;
  }

  function updateBinPanel() {
    const body = document.getElementById('bin-body');
    if (!body) return;

    // 选中未确认时按“拿走之后”的局面预览
    const isPreview = selection !== null;
    const piles = isPreview ? previewPiles() : game.piles;
    const xor = piles.reduce(function (a, b) { return a ^ b; });

    function row(label, num, bits, cls) {
      return '<div class="bin-row ' + (cls || '') + '">' +
        '<span class="bin-label">' + label + '</span>' +
        '<span class="bin-num">' + num + '</span>' +
        '<code class="bin-bits">' + bits.split('').join(' ') + '</code>' +
        '</div>';
    }

    body.innerHTML =
      '<div class="bin-table">' +
        '<div class="bin-row head"><span>排</span><span>数量</span><span>二进制</span></div>' +
        row('第1排', piles[0], toBits(piles[0])) +
        row('第2排', piles[1], toBits(piles[1])) +
        row('第3排', piles[2], toBits(piles[2])) +
        '<div class="bin-sep"></div>' +
        row('异或 XOR', xor, toBits(xor), 'op xor') +
      '</div>' +
      (isPreview
        ? '<p class="bin-preview">👆 预览：按当前选中拿取后的局面计算</p>'
        : '<p class="bin-tip"><b>异或 (XOR)</b> 是普通 Nim 的取胜关键；本游戏是 misère 规则' +
          '（拿最后一颗输），残局存在例外，请以「💡 提示」的精确解为准。</p>');
  }

  // ---- 高亮当前选中的排 ----
  function refreshRowHighlight() {
    board.querySelectorAll('.row').forEach(function (rowEl) {
      rowEl.classList.toggle('row-active', selection !== null && Number(rowEl.dataset.row) === selection.row);
    });
  }

  // 根据 selection 给骰子加 .selected（提示时叠加 .hint 脉动）
  function applySelection() {
    board.querySelectorAll('.die').forEach(function (die) {
      const row = Number(die.dataset.row);
      const index = Number(die.dataset.index);
      const inSel = selection !== null && row === selection.row && index < selection.count;
      die.classList.toggle('selected', inSel);
      die.classList.toggle('hint', hintActive && inSel);
    });
    updateBinPanel();
  }

  // ---- 点击骰子 ----
  board.addEventListener('click', function (e) {
    if (busy || G357.isOver(game)) return;
    const die = e.target.closest('.die');
    if (!die) return;

    const row = Number(die.dataset.row);
    const index = Number(die.dataset.index);

    // 该排前 index+1 颗都会被拿走
    const count = index + 1;
    // 手动点选会退出「提示」状态
    hintActive = false;
    if (selection !== null && selection.row === row && selection.count === count) {
      // 再点同一颗 = 取消整排选择
      selection = null;
    } else {
      selection = { row: row, count: count };
    }
    applySelection();
    refreshRowHighlight();
    updateControls();
  });

  function updateControls() {
    const hasSel = selection !== null;
    btnConfirm.disabled = !hasSel || busy || G357.isOver(game);
    btnCancel.disabled = !hasSel || busy;
    btnHint.disabled = busy || G357.isOver(game) || game.mode !== G357.MODE_AI || game.currentPlayer !== G357.PLAYER_1;
    if (hintActive && hasSel) {
      pickInfo.textContent = `💡 建议：从第 ${selection.row + 1} 排拿走 ${selection.count} 颗，点「确认拿取」即可`;
    } else if (hasSel) {
      pickInfo.textContent = `已选：第 ${selection.row + 1} 排前 ${selection.count} 颗`;
    } else {
      pickInfo.textContent = '点选要拿走的骰子（只能在同一排拿）';
    }
  }

  // ---- 提示：用 AI 策略给出建议并直接选中 ----
  btnHint.addEventListener('click', function () {
    if (busy || G357.isOver(game) || game.mode !== G357.MODE_AI || game.currentPlayer !== G357.PLAYER_1) return;
    const move = G357AI.getMove(game);
    if (!move) return;
    selection = { row: move.row, count: move.count };
    hintActive = true;
    applySelection();
    refreshRowHighlight();
    updateControls();
  });

  // ---- 确认拿取 ----
  btnConfirm.addEventListener('click', function () {
    if (!selection || busy || G357.isOver(game)) return;
    takeDice(selection.row, selection.count);
  });

  btnCancel.addEventListener('click', function () {
    if (busy) return;
    selection = null;
    hintActive = false;
    applySelection();
    refreshRowHighlight();
    updateControls();
  });

  // ---- 执行一步拿取（人 / AI 共用）----
  async function takeDice(row, count) {
    const token = gameToken;
    busy = true;
    const mover = game.currentPlayer;
    selection = null;
    hintActive = false;
    applySelection();
    updateControls();

    // 1) 动画：选中的骰子消失
    board.querySelectorAll('.die').forEach(function (die) {
      if (Number(die.dataset.row) === row && Number(die.dataset.index) < count) {
        die.classList.add('removing');
      }
    });
    await delay(DIE_ANIM_MS);
    if (token !== gameToken) return; // 对局已重置/切换，丢弃过期动作

    // 2) 落子
    const result = G357.makeMove(game, row, count);
    if (!result.ok) {
      busy = false;
      updateControls();
      return;
    }

    // 3) 日志
    addLog(mover, row, count);

    // 4) 重渲染
    renderBoard();
    updateTurnBanner();

    if (result.winner !== null) {
      showResult(result.winner);
      busy = false;
      updateControls();
      return;
    }

    // 5) AI 回合调度
    if (game.mode === G357.MODE_AI && game.currentPlayer === G357.PLAYER_2) {
      turnText.textContent = '🤖 电脑思考中…';
      await delay(AI_THINK_MS);
      if (token !== gameToken || G357.isOver(game)) return;
      const move = G357AI.getMove(game);
      if (move) await takeDice(move.row, move.count);
      return;
    }

    busy = false;
    updateControls();
  }

  // ---- 回合指示 ----
  function updateTurnBanner() {
    const p = game.currentPlayer;
    turnBanner.classList.remove('player-1', 'player-2');
    turnBanner.classList.add(p === G357.PLAYER_1 ? 'player-1' : 'player-2');
    if (G357.isOver(game)) {
      turnText.textContent = '对局结束';
    } else {
      turnText.textContent = `${playerIcon(p)} 轮到 ${playerName(p)}`;
    }
  }

  // ---- 走子日志 ----
  function addLog(player, row, count) {
    // 移除空占位提示
    const empty = logList.querySelector('.log-empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = player === G357.PLAYER_1 ? 'p1' : 'p2';
    // 形象前缀仅用于双人模式；AI 模式日志保持纯文字不变
    const prefix = game.mode === G357.MODE_PVP ? playerIcon(player) + ' ' : '';
    li.textContent = `${prefix}${playerName(player)}：从第 ${row + 1} 排拿走 ${count} 颗`;
    logList.appendChild(li);
    logList.scrollTop = logList.scrollHeight;
  }

  // ---- 胜负横幅 ----
  function showResult(winner) {
    const loser = winner === G357.PLAYER_1 ? G357.PLAYER_2 : G357.PLAYER_1;
    resultTitle.textContent = `${playerName(winner)} 获胜！`;
    resultTitle.className = 'result-title ' + (winner === G357.PLAYER_1 ? 'win-p1' : 'win-p2');
    resultSub.textContent = `${playerName(loser)} 拿到了最后一颗骰子`;
    resultIcon.textContent = winner === G357.PLAYER_1
      ? (game.mode === G357.MODE_AI ? '🏆' : AVATARS[avatar.p1])
      : (game.mode === G357.MODE_AI ? '🤖' : AVATARS[avatar.p2]);
    overlay.classList.remove('hidden');
  }

  // ---- 模式切换 ----
  function setMode(mode) {
    game = G357.createGame(mode);
    modePvp.classList.toggle('active', mode === G357.MODE_PVP);
    modeAi.classList.toggle('active', mode === G357.MODE_AI);
    aiFirstToggle.classList.toggle('hidden', mode !== G357.MODE_AI);
    setAvatarPanelVisible(mode === G357.MODE_PVP);
    startNewGame();
  }

  modePvp.addEventListener('click', function () { setMode(G357.MODE_PVP); });
  modeAi.addEventListener('click', function () { setMode(G357.MODE_AI); });

  // ---- 重新开始 ----
  function startNewGame() {
    gameToken += 1;
    busy = false;
    selection = null;
    hintActive = false;
    G357.reset(game);
    logList.innerHTML = '<li class="log-empty">还没有走子记录</li>';
    overlay.classList.add('hidden');
    renderBoard();
    updateTurnBanner();
    updateControls();
    // AI 先手：电脑走第一手（currentPlayer 刚改为 PLAYER_2，需重刷轮次与按钮态）
    if (game.mode === G357.MODE_AI && aiFirstInput.checked) {
      game.currentPlayer = G357.PLAYER_2;
      updateTurnBanner();
      updateControls();
      scheduleAiFirstMove();
    }
  }

  // 电脑先手的第一手：模拟思考后由 AI 落子
  async function scheduleAiFirstMove() {
    const token = gameToken;
    busy = true;
    turnText.textContent = '🤖 电脑思考中…';
    updateControls();
    await delay(AI_THINK_MS);
    if (token !== gameToken || G357.isOver(game)) return;
    const move = G357AI.getMove(game);
    if (move) await takeDice(move.row, move.count);
  }

  btnReset.addEventListener('click', startNewGame);
  btnRestart.addEventListener('click', startNewGame);

  // ---- 启动 ----
  renderAvatarPanel();
  setAvatarPanelVisible(game.mode === G357.MODE_PVP); // 默认 PvP：首屏即显示
  startNewGame();
})();
