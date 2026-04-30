// --- 线下剧情文游模式 (js/modules/theater.js) ---
// 独立展示，底层仍复用当前私聊角色的 history / 日记 / 上下文。

const TheaterMode = (() => {
    const SCREEN_ID = 'theater-screen';
    const SCRATCH_IMG = 'https://i.postimg.cc/8cYnZZT7/scratch.png';
    const SETTINGS_SCREEN_ID = 'theater-settings-screen';
    const HISTORY_SCREEN_ID = 'theater-history-screen';
    const HISTORY_EDIT_SHEET_ID = 'theater-history-edit-sheet';
    const GALLERY_SCREEN_ID = 'theater-gallery-screen';

    /** @type {{ chatId: string, sessionId: string, msgId: string } | null} */
    let historyEditCtx = null;
    const DEFAULT_BG = 'linear-gradient(160deg, #17131f 0%, #2d2436 48%, #0e1018 100%)';

    const state = {
        chatId: null,
        sessionId: null,
        blockIndex: 0,
        currentBlocks: [],
        currentMessageId: null,
        playbackKind: null,
        generating: false,
        imageTasks: {},
        drag: null,
        historyReplay: false,
        /** 剧情回顾页当前浏览的场次（仅 UI，不改变 activeSessionId / AI 上下文） */
        historyBrowseSessionId: null
    };

    function $(id) {
        return document.getElementById(id);
    }

    function safeText(text) {
        return DOMPurify.sanitize(String(text || ''), { ALLOWED_TAGS: [] });
    }

    function currentChat() {
        if (typeof currentChatType === 'undefined' || currentChatType !== 'private') return null;
        return db.characters.find(c => c.id === currentChatId) || null;
    }

    function theaterState(chat) {
        if (!chat.theater) {
            chat.theater = {
                activeSessionId: null,
                sessions: [],
                backgrounds: [],
                settings: {
                    generateBackground: true,
                    waitForBackground: false,
                    spriteDataUrl: '',
                    userSpriteDataUrl: '',
                    spriteSize: 'medium',
                    spriteOffsetY: 0,
                    spriteScale: 1,
                    userSpriteOffsetY: 0,
                    userSpriteScale: 1
                }
            };
        }
        if (!Array.isArray(chat.theater.sessions)) chat.theater.sessions = [];
        if (!Array.isArray(chat.theater.backgrounds)) chat.theater.backgrounds = [];
        if (!chat.theater.settings) chat.theater.settings = {};
        const s = chat.theater.settings;
        if (s.spriteDataUrl === undefined) s.spriteDataUrl = '';
        if (s.userSpriteDataUrl === undefined) s.userSpriteDataUrl = '';
        if (s.generateBackground === undefined) s.generateBackground = true;
        if (s.waitForBackground === undefined) s.waitForBackground = false;
        if (s.spriteOffsetY === undefined) s.spriteOffsetY = 0;
        if (s.spriteScale === undefined) s.spriteScale = 1;
        if (s.userSpriteOffsetY === undefined) s.userSpriteOffsetY = 0;
        if (s.userSpriteScale === undefined) s.userSpriteScale = 1;
        return chat.theater;
    }

    function theaterMessages(chat, sessionId) {
        return (chat.history || []).filter(m => m && m.mode === 'theater' && (!sessionId || m.theaterSessionId === sessionId));
    }

    /** 单次遍历 history：该场次的剧场消息、非边界首尾全局下标、最后一条含 blocks 的 assistant（供渲染复用）。 */
    function theaterSessionSlice(chat, sessionId) {
        const hist = chat.history || [];
        const msgs = [];
        let firstRealIdx = -1;
        let lastRealIdx = -1;
        let latestAssistantWithBlocks = null;
        for (let i = 0; i < hist.length; i++) {
            const m = hist[i];
            if (!m || m.mode !== 'theater' || m.theaterSessionId !== sessionId) continue;
            msgs.push(m);
            if (m.theaterBoundary) continue;
            if (firstRealIdx < 0) firstRealIdx = i;
            lastRealIdx = i;
            if (m.role === 'assistant' && Array.isArray(m.theaterBlocks) && m.theaterBlocks.length) {
                latestAssistantWithBlocks = m;
            }
        }
        return { msgs, firstRealIdx, lastRealIdx, latestAssistantWithBlocks };
    }

    /** 将本轮最后一条 assistant 剧场消息标为「已看完」，避免用户播完自己的块后又跳回上一段 AI。 */
    function markLatestAssistantTheaterDismissed(chat, session) {
        if (!chat || !session) return;
        const latest = theaterMessages(chat, session.id)
            .filter(m => m.role === 'assistant' && Array.isArray(m.theaterBlocks) && m.theaterBlocks.length)
            .slice(-1)[0];
        if (!latest) return;
        latest.lastViewedBlockIndex = latest.theaterBlocks.length;
    }

    function isAssistantTheaterFullyDismissed(msg) {
        if (!msg || !Array.isArray(msg.theaterBlocks) || !msg.theaterBlocks.length) return true;
        const n = msg.theaterBlocks.length;
        const v = Number(msg.lastViewedBlockIndex);
        return Number.isFinite(v) && v >= n;
    }

    function getActiveTheaterSession(chat) {
        const ts = theaterState(chat);
        if (!ts.activeSessionId) return null;
        return ts.sessions.find(s => s.id === ts.activeSessionId && !s.endedAt) || null;
    }

    /** 剧情历史页用：优先进行中场次，否则最近一次已结束场次（数据仍在 history，仅 activeSession 被清空）。 */
    function resolveTheaterHistorySession(chat) {
        if (!chat) return null;
        const active = getActiveTheaterSession(chat);
        if (active) return active;
        const list = theaterState(chat).sessions;
        if (!Array.isArray(list) || !list.length) return null;
        const ended = list.filter(s => s.endedAt);
        if (ended.length) {
            return ended.reduce((a, b) => (b.endedAt > a.endedAt ? b : a));
        }
        return list.reduce((a, b) => ((b.startedAt || 0) > (a.startedAt || 0) ? b : a));
    }

    function getOrCreateTheaterSession(chat) {
        let session = getActiveTheaterSession(chat);
        if (session) return session;
        const ts = theaterState(chat);
        const id = `theater_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        session = {
            id,
            title: '线下剧情',
            startedAt: Date.now(),
            startIndex: (chat.history || []).length + 1,
            endIndex: (chat.history || []).length + 1
        };
        ts.sessions.push(session);
        ts.activeSessionId = id;
        return session;
    }

    function sessionHasBoundaryStart(chat, sessionId) {
        return (chat.history || []).some(m =>
            m && m.mode === 'theater' && m.theaterSessionId === sessionId && m.theaterBoundary === 'start'
        );
    }

    function insertTheaterBoundaryStart(chat, session) {
        if (sessionHasBoundaryStart(chat, session.id)) return;
        const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const boundary = {
            id: msgId,
            role: 'user',
            content: '[system: 当前进入线下剧场模式。请从上一条线上聊天自然衔接为面对面场景，使用小说体、旁白和对白推进。]',
            parts: [{ type: 'text', text: '[system: 当前进入线下剧场模式。请从上一条线上聊天自然衔接为面对面场景，使用小说体、旁白和对白推进。]' }],
            timestamp: Date.now(),
            mode: 'theater',
            theaterBoundary: 'start',
            theaterSessionId: session.id
        };
        const firstIdx = chat.history.findIndex(m =>
            m && m.mode === 'theater' && m.theaterSessionId === session.id && !m.theaterBoundary
        );
        if (firstIdx >= 0) {
            chat.history.splice(firstIdx, 0, boundary);
        } else {
            chat.history.push(boundary);
        }
    }

    function parseUserTheaterInput(raw) {
        const s = String(raw || '').replace(/\r\n/g, '\n');
        const blocks = [];
        if (!s.trim()) return blocks;
        const pairs = [
            ['\u201c', '\u201d'],
            ['「', '」'],
            ['"', '"']
        ];
        let i = 0;
        while (i < s.length) {
            ch: {
                let next = -1;
                let pair = null;
                for (const [op, cl] of pairs) {
                    const j = s.indexOf(op, i);
                    if (j >= 0 && (next < 0 || j < next)) {
                        next = j;
                        pair = [op, cl];
                    }
                }
                if (next < 0) {
                    const rest = s.slice(i).trim();
                    if (rest) blocks.push({ type: 'narration', text: rest });
                    break ch;
                }
                const before = s.slice(i, next).trim();
                if (before) blocks.push({ type: 'narration', text: before });
                const [op, cl] = pair;
                const close = s.indexOf(cl, next + op.length);
                if (close < 0) {
                    const rest = s.slice(next).trim();
                    if (rest) blocks.push({ type: 'narration', text: rest });
                    break ch;
                }
                const inner = s.slice(next + op.length, close).trim();
                if (inner) blocks.push({ type: 'dialogue', speaker: '', text: inner });
                i = close + cl.length;
                continue;
            }
            break;
        }
        return blocks.filter(b => b.text);
    }

    function userBlocksToContent(blocks, chat) {
        const name = chat.myName || '我';
        return blocks.map(b => (
            b.type === 'dialogue'
                ? `${name}：“${b.text}”`
                : `[旁白｜${name}] ${b.text}`
        )).join('\n\n');
    }

    function patchTheaterDomIfNeeded() {
        const screen = $(SCREEN_ID);
        if (!screen) return;
        const legacySend = $('theater-send-btn');
        if (legacySend) legacySend.remove();
        const wrap = document.querySelector('#theater-screen .theater-input-wrap');
        if (wrap) {
            wrap.style.display = '';
            wrap.style.alignItems = '';
            wrap.style.gap = '';
        }
        const ta = $('theater-input');
        if (ta) {
            ta.style.flex = '';
            ta.style.minWidth = '';
            ta.style.width = '';
        }
        const stage = $('theater-stage');
        if (stage && !$('theater-user-sprite')) {
            const u = document.createElement('img');
            u.className = 'theater-user-sprite';
            u.id = 'theater-user-sprite';
            u.alt = '';
            stage.appendChild(u);
        }
    }

    function ensureScreen() {
        const _e0 = performance.now();
        const _hadMainScreen = !!$(SCREEN_ID);
        const _hadSub = !!$(SETTINGS_SCREEN_ID);
        const host = document.querySelector('.phone-screen') || document.body;
        injectStyles();
        ensureTheaterInputNoScrollbarStyle();
        if ($(SCREEN_ID)) {
            patchTheaterDomIfNeeded();
            return;
        }

        const screen = document.createElement('div');
        screen.id = SCREEN_ID;
        screen.className = 'screen theater-screen';
        screen.innerHTML = `
            <div class="theater-bg-layer" id="theater-bg-layer"></div>
            <div class="theater-topbar">
                <button class="theater-icon-btn" id="theater-back-btn" title="返回">‹</button>
                <div class="theater-title-wrap">
                    <div class="theater-title">线下剧情</div>
                    <div class="theater-range" id="theater-range" hidden>未开始</div>
                </div>
                <button class="theater-icon-btn" id="theater-settings-btn" title="设置">⚙</button>
            </div>
            <div class="theater-stage" id="theater-stage">
                <img class="theater-sprite" id="theater-sprite" alt="">
                <img class="theater-user-sprite" id="theater-user-sprite" alt="">
                <div class="theater-empty" id="theater-empty" hidden aria-hidden="true"></div>
            </div>
            <div class="theater-dialogue-area" id="theater-dialogue-area" hidden>
                <div class="theater-speaker" id="theater-speaker"></div>
                <div class="theater-text" id="theater-text"></div>
                <div class="theater-next-hint" id="theater-next-hint"></div>
            </div>
            
            <button type="button" class="theater-scratch-btn" id="theater-paw-btn" aria-label="请求剧情" title="请求剧情">
                <img src="${SCRATCH_IMG}" alt="" width="32" height="32" decoding="async" />
                <span class="theater-scratch-ripple-host" aria-hidden="true"></span>
            </button>
            <button type="button" class="theater-history-fab" id="theater-history-btn" aria-label="剧情历史" title="剧情历史">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
                </svg>
            </button>
            <button type="button" class="theater-input-toggle-btn" id="theater-input-toggle-btn" aria-label="输入" title="输入">
                ✏️
            </button>

            <div class="theater-input-panel" id="theater-input-panel">
                <div class="theater-input-wrap">
                    <textarea id="theater-input" rows="1" placeholder="说点什么..."></textarea>
                </div>
            </div>
            <div class="theater-bg-status" id="theater-bg-status" hidden></div>
        `;

        host.appendChild(screen);

        $('theater-back-btn').addEventListener('click', () => switchScreen('chat-room-screen'));
        $('theater-settings-btn').addEventListener('click', openSettings);
        $('theater-history-btn').addEventListener('click', openHistory);
        $('theater-stage').addEventListener('click', (e) => {
            if (e.target && (e.target.closest('#theater-paw-btn') || e.target.closest('#theater-history-btn') || e.target.closest('#theater-input-toggle-btn') || e.target.closest('#theater-input-panel'))) return;
            // 方案 A：舞台/背景只切换沉浸（图标显隐）；推进仅对话区负责
            screen.classList.toggle('reading-mode');
        });
        $('theater-dialogue-area').addEventListener('click', (e) => {
            e.stopPropagation();
            nextBlock();
        });
        
        const ta = $('theater-input');
        const inputPanel = $('theater-input-panel');
        $('theater-input-toggle-btn').addEventListener('click', () => {
            if (inputPanel.classList.contains('active')) {
                inputPanel.classList.remove('active');
                ta.blur();
            } else {
                inputPanel.classList.add('active');
            }
        });
        ta.addEventListener('input', autoGrowInput);
        ta.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.isComposing) return;
            if (e.shiftKey) return;
            e.preventDefault();
            inputPanel.classList.remove('active');
            sendUserTurn();
            ta.blur();
        });
        
        setupPawDrag();
    }

    function lazyEnsureSubScreens() {
        const host = document.querySelector('.phone-screen') || document.body;
        ensureSubScreens(host);
    }

    function ensureSubScreens(host) {
        if ($(SETTINGS_SCREEN_ID)) return;

        const settings = document.createElement('div');
        settings.id = SETTINGS_SCREEN_ID;
        settings.className = 'theater-sub-screen';
        settings.innerHTML = `
            <div class="theater-sub-topbar">
                <button type="button" class="theater-icon-btn" id="theater-settings-back" title="返回">‹</button>
                <div class="theater-title">设置</div>
                <span class="theater-topbar-spacer"></span>
            </div>
            <div class="theater-sub-scroll" id="theater-settings-body"></div>
        `;

        const history = document.createElement('div');
        history.id = HISTORY_SCREEN_ID;
        history.className = 'theater-sub-screen';
        history.innerHTML = `
            <div class="theater-sub-topbar">
                <button type="button" class="theater-icon-btn" id="theater-history-back" title="返回">‹</button>
                <div class="theater-title">剧情回顾</div>
                <span class="theater-topbar-spacer"></span>
            </div>
            <div class="theater-sub-scroll" id="theater-history-body"></div>
        `;

        const gallery = document.createElement('div');
        gallery.id = GALLERY_SCREEN_ID;
        gallery.className = 'theater-sub-screen';
        gallery.innerHTML = `
            <div class="theater-sub-topbar">
                <button type="button" class="theater-icon-btn" id="theater-gallery-back" title="返回">‹</button>
                <div class="theater-title">背景图册</div>
                <span class="theater-topbar-spacer"></span>
            </div>
            <div class="theater-sub-scroll" id="theater-gallery-body"></div>
        `;

        host.appendChild(settings);
        host.appendChild(history);
        host.appendChild(gallery);

        ensureHistoryEditSheet(history);

        settings.querySelector('#theater-settings-back').addEventListener('click', () => {
            $(SETTINGS_SCREEN_ID).classList.remove('active');
        });
        history.querySelector('#theater-history-back').addEventListener('click', () => {
            closeTheaterHistoryEdit();
            state.historyBrowseSessionId = null;
            $(HISTORY_SCREEN_ID).classList.remove('active');
        });
        gallery.querySelector('#theater-gallery-back').addEventListener('click', () => {
            $(GALLERY_SCREEN_ID).classList.remove('active');
            $(SETTINGS_SCREEN_ID).classList.add('active');
        });
    }

    function injectStyles() {
        if (document.querySelector('link[href="css/modules/theater.css"]')) return;
        if ($('theater-style')) return;
        const link = document.createElement('link');
        link.id = 'theater-style';
        link.rel = 'stylesheet';
        link.href = 'css/modules/theater.css';
        document.head.appendChild(link);
    }

    function open() {
        // #region agent log
        const _tOpen0 = performance.now();
        const _ep0 = performance.now();
        // #endregion
        ensureScreen();
        // #region agent log
        const _msEnsure = Math.round(performance.now() - _ep0);
        // #endregion
        patchTheaterDomIfNeeded();
        const chat = currentChat();
        if (!chat) {
            showToast('线下剧情目前仅支持单聊角色');
            return;
        }
        const pawRe = $('theater-paw-btn');
        if (pawRe) {
            pawRe.style.left = '';
            pawRe.style.top = '';
            pawRe.style.right = '';
            pawRe.style.bottom = '';
        }
        const session = getActiveTheaterSession(chat);
        state.chatId = chat.id;
        state.sessionId = session ? session.id : null;
        state.playbackKind = null;
        // 与日记/日程一致：先切屏、再关扩展面板；重渲染与 Dexie 落库勿塞进首帧（见 schedule_day：bulkPut 可卡主线程很久）。
        // #region agent log
        const _sw0 = performance.now();
        // #endregion
        switchScreen(SCREEN_ID);
        if (typeof showPanel === 'function') showPanel('none');
        // #region agent log
        const _msSwitch = Math.round(performance.now() - _sw0);
        const _msUntilSwitch = Math.round(performance.now() - _tOpen0);
        // #endregion
        requestAnimationFrame(() => {
            // #region agent log
            const _r0 = performance.now();
            // #endregion
            renderAll(chat);
            // #region agent log
            const _msRenderAll = Math.round(performance.now() - _r0);
            const _data = {
                msUntilSwitch: _msUntilSwitch,
                msFromRafToRenderEnd: Math.round(performance.now() - _r0),
                msEnsureWrap: _msEnsure,
                msRenderAll: _msRenderAll,
                msSwitch: _msSwitch,
                historyLen: (chat.history || []).length,
                hasSession: !!session,
                fix: 'switchFirst+panelAfter+rAF_renderAll+idleSave'
            };
            try { console.log('[TheaterDebug] open_phases', _data); } catch (e) { /* ignore */ }
            fetch('http://127.0.0.1:7540/ingest/2f027be0-fce7-46b5-a8e3-9193a116129e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1e7660'},body:JSON.stringify({sessionId:'1e7660',location:'theater.js:open',message:'open_phases',data:_data,timestamp:Date.now(),runId:'post-fix-v3',hypothesisId:'H-perceived'})}).catch(()=>{});
            // #endregion
            const persist = () => {
                // #region agent log
                const _sv0 = performance.now();
                // #endregion
                if (typeof saveData === 'function') saveData();
                // #region agent log
                const _idleSaveMs = Math.round(performance.now() - _sv0);
                try { console.log('[TheaterDebug] open_idle_save', { msSaveCall: _idleSaveMs }); } catch (e) { /* ignore */ }
                fetch('http://127.0.0.1:7540/ingest/2f027be0-fce7-46b5-a8e3-9193a116129e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1e7660'},body:JSON.stringify({sessionId:'1e7660',location:'theater.js:open',message:'open_idle_save',data:{msSaveCall:_idleSaveMs},timestamp:Date.now(),runId:'post-fix-v3',hypothesisId:'H3-saveData'})}).catch(()=>{});
                // #endregion
            };
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(persist, { timeout: 2500 });
            } else {
                requestAnimationFrame(persist);
            }
        });
    }

    function renderAll(chat) {
        const session = getActiveTheaterSession(chat);
        state.sessionId = session ? session.id : null;
        if (!session) {
            const rangeEl = $('theater-range');
            if (rangeEl) rangeEl.textContent = '尚未开局';
            state.currentBlocks = [];
            state.currentMessageId = null;
            state.blockIndex = 0;
            state.playbackKind = null;
            state.historyReplay = false;
            const emptyEl = $('theater-empty');
            if (emptyEl) emptyEl.hidden = true;
            $('theater-dialogue-area').hidden = true;
            updateStandees(null, null, null);
            setBackgroundImage('');
            autoGrowInput();
            return;
        }
        const slice = theaterSessionSlice(chat, session.id);
        updateRange(chat, session, slice);
        renderLatestBlocks(chat, session, slice);
        renderLatestBackground(chat, session.id);
        autoGrowInput();
    }

    function updateRange(chat, session, slice) {
        const s = slice || theaterSessionSlice(chat, session.id);
        const real = s.msgs.filter(m => !m.theaterBoundary);
        if (real.length) {
            const first = s.firstRealIdx >= 0 ? s.firstRealIdx + 1 : session.startIndex;
            const last = s.lastRealIdx >= 0 ? s.lastRealIdx + 1 : (session.endIndex || first);
            session.startIndex = first;
            session.endIndex = last;
            $('theater-range').textContent = `本次范围：消息 ${first}-${last}`;
        } else {
            const si = session.startIndex;
            $('theater-range').textContent = si ? `本次范围：自第 ${si} 条消息起` : '尚未开局';
        }
    }

    function clampSpriteOffset(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return Math.min(200, Math.max(-380, n));
    }

    function clampSpriteScale(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return 1;
        return Math.min(1.55, Math.max(0.45, n));
    }

    function updateStandees(chat, block, playbackKind) {
        const charImg = $('theater-sprite');
        const userImg = $('theater-user-sprite');
        if (!charImg || !userImg) return;
        charImg.classList.remove('visible');
        userImg.classList.remove('visible');
        charImg.style.transform = '';
        userImg.style.transform = '';
        if (!chat || !block || block.type !== 'dialogue') return;
        const settings = theaterState(chat).settings;
        const coy = clampSpriteOffset(settings.spriteOffsetY);
        const cs = clampSpriteScale(settings.spriteScale);
        const uoy = clampSpriteOffset(settings.userSpriteOffsetY);
        const us = clampSpriteScale(settings.userSpriteScale);
        if (playbackKind === 'user') {
            if (settings.userSpriteDataUrl) {
                userImg.src = settings.userSpriteDataUrl;
                userImg.style.transform = `translateY(${uoy}px) scale(${us})`;
                userImg.classList.add('visible');
            }
        } else if (playbackKind === 'assistant') {
            if (settings.spriteDataUrl) {
                charImg.src = settings.spriteDataUrl;
                charImg.style.transform = `translateY(${coy}px) scale(${cs})`;
                charImg.classList.add('visible');
            }
        }
    }

    /** 仅重算立绘 transform（设置里拖滑块用），勿调用 renderAll，否则会重跑 renderLatestBlocks 易把对白区误判收起 */
    function refreshTheaterSpritesOnly(chat) {
        const c = chat || currentChat();
        if (!c || !$(SCREEN_ID)) return;
        const area = $('theater-dialogue-area');
        if (!area || area.hidden) {
            updateStandees(null, null, null);
            return;
        }
        const block = state.currentBlocks[state.blockIndex];
        if (block) updateStandees(c, block, state.playbackKind);
        else updateStandees(null, null, null);
    }

    function renderLatestBlocks(chat, session, slice) {
        state.historyReplay = false;
        const s = slice || theaterSessionSlice(chat, session.id);
        const latestAssistant = s.latestAssistantWithBlocks;
        if (!latestAssistant || isAssistantTheaterFullyDismissed(latestAssistant)) {
            state.currentBlocks = [];
            state.currentMessageId = null;
            state.blockIndex = 0;
            state.playbackKind = null;
            $('theater-dialogue-area').hidden = true;
            updateStandees(null, null, null);
            const idleHint = $('theater-empty');
            if (idleHint) idleHint.hidden = true;
            return;
        }
        const blocks = Array.isArray(latestAssistant.theaterBlocks) ? latestAssistant.theaterBlocks : [];
        if (!blocks.length) {
            state.currentBlocks = [];
            state.currentMessageId = null;
            state.blockIndex = 0;
            state.playbackKind = null;
            $('theater-dialogue-area').hidden = true;
            updateStandees(null, null, null);
            const idleHint = $('theater-empty');
            if (idleHint) idleHint.hidden = true;
            return;
        }
        state.playbackKind = 'assistant';
        state.currentBlocks = blocks;
        state.currentMessageId = latestAssistant.id;
        const n = blocks.length;
        let idx = Math.min(Math.max(0, Number(latestAssistant.lastViewedBlockIndex) || 0), n - 1);
        if (!blocks[idx]) idx = 0;
        state.blockIndex = idx;
        showBlock(state.blockIndex, chat);
    }

    function showBlock(index, chatRef) {
        const chat = chatRef || currentChat();
        const block = state.currentBlocks[index];
        if (!block) {
            const area = $('theater-dialogue-area');
            if (area) area.hidden = true;
            $('theater-text').textContent = '';
            $('theater-speaker').textContent = '';
            return;
        }
        $('theater-empty').hidden = true;
        const area = $('theater-dialogue-area');
        area.hidden = false;
        const isNarr = block.type !== 'dialogue';
        area.classList.toggle('narration', isNarr);
        area.classList.toggle('user-line', state.playbackKind === 'user');
        if (block.type === 'dialogue') {
            const name = state.playbackKind === 'user'
                ? (chat ? (chat.myName || '我') : '我')
                : safeText(block.speaker || (chat ? (chat.remarkName || chat.realName || '角色') : '角色'));
            $('theater-speaker').textContent = name;
        } else {
            $('theater-speaker').textContent = '';
        }
        $('theater-text').textContent = block.text || '';
        updateStandees(chat, block, state.playbackKind);

        const msg = chat && state.currentMessageId && chat.history.find(m => m.id === state.currentMessageId);
        if (msg && !state.historyReplay) msg.lastViewedBlockIndex = index;
    }

    /** 将 assistant 的 content（与 blocksToText 一致的段落）还原为复盘 blocks，避免整条掉进单一旁白条导致无立绘 */
    function assistantContentToReplayBlocks(raw, chat) {
        const text = String(raw || '').replace(/\r\n/g, '\n').trim();
        if (!text) return [];
        const defaultSpeaker = chat ? (chat.remarkName || chat.realName || chat.name || '角色') : '角色';
        const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
        const quotePairs = [
            ['\u201c', '\u201d'],
            ['\u2018', '\u2019'],
            ['"', '"'],
            ['「', '」']
        ];
        const out = [];
        for (const p of paras) {
            const colonWide = p.indexOf('：');
            const colonAscii = p.indexOf(':');
            let colonIdx = -1;
            if (colonWide >= 0 && colonAscii >= 0) colonIdx = Math.min(colonWide, colonAscii);
            else colonIdx = Math.max(colonWide, colonAscii);
            if (colonIdx <= 0) {
                out.push({ type: 'narration', speaker: '', text: p });
                continue;
            }
            const speaker = p.slice(0, colonIdx).trim();
            const rest = p.slice(colonIdx + 1).trim();
            let matched = false;
            for (const [op, cl] of quotePairs) {
                if (rest.startsWith(op) && rest.endsWith(cl) && rest.length >= op.length + cl.length + 1) {
                    const inner = rest.slice(op.length, rest.length - cl.length).trim();
                    if (inner) {
                        out.push({ type: 'dialogue', speaker: speaker || defaultSpeaker, text: inner });
                        matched = true;
                        break;
                    }
                }
            }
            if (!matched) out.push({ type: 'narration', speaker: '', text: p });
        }
        return out.filter(b => b.text);
    }

    function normalizeReplayBlocks(msg, chat) {
        const c = chat || currentChat();
        let blocks = [];
        if (msg.role === 'user' && Array.isArray(msg.theaterUserBlocks) && msg.theaterUserBlocks.length) {
            blocks = msg.theaterUserBlocks.slice();
        } else if (msg.role === 'assistant' && Array.isArray(msg.theaterBlocks) && msg.theaterBlocks.length) {
            blocks = msg.theaterBlocks.slice();
        }
        blocks = blocks.map(b => ({
            type: String(b.type || '').toLowerCase() === 'dialogue' ? 'dialogue' : 'narration',
            speaker: b.speaker || '',
            text: String(b.text || '').trim()
        })).filter(b => b.text);

        const contentTrim = String(msg.content || '').replace(/\r\n/g, '\n').trim();

        if (!blocks.length) {
            if (contentTrim) {
                if (msg.role === 'assistant') {
                    blocks = assistantContentToReplayBlocks(contentTrim, c);
                }
                if (!blocks.length) {
                    blocks = [{ type: 'narration', speaker: '', text: contentTrim }];
                }
            }
        } else if (
            msg.role === 'assistant'
            && blocks.length === 1
            && blocks[0].type === 'narration'
            && contentTrim
            && String(blocks[0].text || '').replace(/\r\n/g, '\n').trim() === contentTrim
        ) {
            const parsed = assistantContentToReplayBlocks(contentTrim, c);
            if (parsed.some(b => b.type === 'dialogue')) blocks = parsed;
        } else if (
            msg.role === 'assistant'
            && blocks.length > 1
            && blocks.every(b => b.type === 'narration')
            && contentTrim
        ) {
            const joined = blocks.map(b => b.text).join('\n\n');
            if (String(joined || '').replace(/\r\n/g, '\n').trim() === contentTrim) {
                const parsed = assistantContentToReplayBlocks(contentTrim, c);
                if (parsed.some(b => b.type === 'dialogue')) blocks = parsed;
            }
        }

        return blocks;
    }

    function beginHistoryReplay(chat, msg, session) {
        if (!chat || !msg || !session) return;
        if (msg.mode !== 'theater' || msg.theaterSessionId !== session.id) {
            showToast('无法复盘该条记录');
            return;
        }
        const blocks = normalizeReplayBlocks(msg, chat);
        if (!blocks.length) {
            showToast('该条没有可复盘的分块内容');
            return;
        }
        state.historyReplay = true;
        state.currentMessageId = msg.id;
        state.currentBlocks = blocks;
        state.blockIndex = 0;
        state.playbackKind = msg.role === 'user' ? 'user' : 'assistant';
        $(HISTORY_SCREEN_ID).classList.remove('active');
        switchScreen(SCREEN_ID);
        showBlock(0, chat);
    }

    function nextBlock() {
        if (!state.currentBlocks.length) return;
        if (state.blockIndex < state.currentBlocks.length - 1) {
            state.blockIndex++;
            showBlock(state.blockIndex, currentChat());
            return;
        }
        if (state.historyReplay) {
            state.historyReplay = false;
            state.playbackKind = null;
            state.currentBlocks = [];
            state.currentMessageId = null;
            state.blockIndex = 0;
            $('theater-next-hint').textContent = '点击继续';
            $('theater-dialogue-area').hidden = true;
            const idleHint = $('theater-empty');
            if (idleHint) idleHint.hidden = true;
            updateStandees(null, null, null);
            return;
        }
        const chat = currentChat();
        const sess = chat ? getActiveTheaterSession(chat) : null;
        if (chat && state.currentMessageId) {
            const cur = chat.history.find(m => m.id === state.currentMessageId);
            if (cur && cur.role === 'assistant' && Array.isArray(cur.theaterBlocks) && cur.theaterBlocks.length) {
                cur.lastViewedBlockIndex = cur.theaterBlocks.length;
            }
        }
        if (chat && sess) {
            markLatestAssistantTheaterDismissed(chat, sess);
        }
        state.playbackKind = null;
        state.currentBlocks = [];
        state.currentMessageId = null;
        state.blockIndex = 0;
        $('theater-next-hint').textContent = '点击继续';
        $('theater-dialogue-area').hidden = true;
        const idleHint = $('theater-empty');
        if (idleHint) idleHint.hidden = true;
        updateStandees(null, null, null);
        if (typeof saveData === 'function') saveData();
    }

    function autoGrowInput() {
        const ta = $('theater-input');
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = Math.min(96, Math.max(42, ta.scrollHeight)) + 'px';
    }

    async function sendUserTurn() {
        const chat = currentChat();
        if (!chat) return;
        const raw = ($('theater-input').value || '').trim();
        if (!raw) {
            showToast('请先输入要发送的内容');
            return;
        }
        const session = getOrCreateTheaterSession(chat);
        let blocks = parseUserTheaterInput(raw);
        if (!blocks.length) {
            blocks = [{ type: 'narration', text: raw }];
        }
        const content = userBlocksToContent(blocks, chat);
        const msg = {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            role: 'user',
            content,
            parts: [{ type: 'text', text: content }],
            timestamp: Date.now(),
            mode: 'theater',
            theaterSessionId: session.id,
            theaterUserBlocks: blocks
        };
        chat.history.push(msg);
        markLatestAssistantTheaterDismissed(chat, session);
        $('theater-input').value = '';
        autoGrowInput();
        state.historyReplay = false;
        state.sessionId = session.id;
        state.playbackKind = 'user';
        state.currentMessageId = msg.id;
        state.currentBlocks = blocks;
        state.blockIndex = 0;
        await saveData();
        updateRange(chat, session);
        showBlock(0, chat);
        const empty = $('theater-empty');
        if (empty) empty.hidden = true;
    }

    async function requestReply() {
        const chat = currentChat();
        if (!chat || state.generating) return;
        const session = getOrCreateTheaterSession(chat);
        insertTheaterBoundaryStart(chat, session);

        state.generating = true;
        setPawLoading(true);
        showBgStatus('正在请求剧情…', null);
        try {
            const data = await fetchTheaterReply(chat, session, '');
            const blocks = normalizeBlocks(data.blocks, data.content, chat);
            const content = blocksToText(blocks);
            const message = {
                id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                role: 'assistant',
                content,
                parts: [{ type: 'text', text: content }],
                timestamp: Date.now(),
                mode: 'theater',
                theaterSessionId: session.id,
                theaterBlocks: blocks,
                scenePrompt: String(data.scenePrompt || '').trim(),
                sessionState: data.sessionState || ''
            };
            chat.history.push(message);
            updateRange(chat, session);
            await saveData();

            state.historyReplay = false;
            state.playbackKind = 'assistant';
            state.currentBlocks = blocks;
            state.currentMessageId = message.id;
            state.blockIndex = 0;
            showBlock(0, chat);

            if (theaterState(chat).settings.generateBackground && message.scenePrompt) {
                generateBackgroundForMessage(chat, message);
            } else {
                hideBgStatusSoon();
            }
        } catch (e) {
            console.error('[TheaterMode]', e);
            showToast('剧情生成失败：' + (e.message || e));
            showBgStatus('剧情生成失败，可以稍后重试。', null);
        } finally {
            state.generating = false;
            setPawLoading(false);
        }
    }

    async function fetchTheaterReply(chat, session, userInput) {
        let { url, key, model, provider } = db.apiSettings;
        if (!url || !key || !model) throw new Error('请先在 api 应用中完成设置');
        if (url.endsWith('/')) url = url.slice(0, -1);

        const basePrompt = typeof generatePrivateSystemPrompt === 'function'
            ? generatePrivateSystemPrompt(chat)
            : `你是角色 ${chat.realName || chat.name}。`;
        const blockSpeakerExample = chat.remarkName || chat.realName || chat.name || '角色';
        const theaterPrompt = `${basePrompt}

【线下剧场模式｜最高优先级】
当前不是线上即时聊天，而是与「${chat.myName}」面对面相处的线下剧情。请从最近上下文自然衔接，不要重开局。

写作规则：
1. 使用第三人称小说体推进，旁白负责环境、动作、细节、氛围和必要心理暗流；角色对白必须符合人设、关系和当前情境。
2. 不要写成微信短消息，不要输出聊天格式，不要使用线上消息拆条规则。
3. 【分块｜必读】前端按 JSON 里 blocks 的每一条展示一屏，用户点一次「继续」进下一条。禁止把多句旁白或多句对白塞进同一个 "text" 里。
   · 旁白 narration：每条约 1～3 个短句，或约 60～130 个汉字；一个镜头或一个叙事节拍拆成一条，不要把整段描写合并成一条。
   · 对白 dialogue：每条一般只写一句（一口气）。若连续两个极短问句可合并为一条，禁止把四句以上发言塞进一条 text。
   · 一轮剧情可以写得很完整，但必须拆成较多 blocks；常见每轮约 6～15 条，按节奏需要可更多。
4. 输出必须是 JSON 对象，不要 Markdown，不要代码块。
5. JSON 结构如下（注意同一轮内多个块）：
{
  "blocks": [
    {"type": "narration", "text": "秋风扫过林梢，碎金般的光落在步道上。"},
    {"type": "narration", "text": "他侧过身，指腹蹭过袖扣，像在斟酌措辞。"},
    {"type": "dialogue", "speaker": "${blockSpeakerExample}", "text": "还能在干嘛？"},
    {"type": "dialogue", "speaker": "${blockSpeakerExample}", "text": "刚去给那帮没长眼的货色结了笔账。"}
  ],
  "scenePrompt": "详细空镜背景生图提示词",
  "sessionState": "当前地点、时间、双方相对位置、气氛和剧情进度摘要"
}
6. scenePrompt 专门用于生成竖屏「无人空镜」背景图，文案要尽量具体，便于生图模型落实：写清地点、空间结构、时间天气、光线方向与冷暖、主要物体、材质、色彩、氛围、镜头角度、前中后景和留白。在以上内容的前提下遵守：只描述环境与静物，不要写、不要暗示画面里会出现本场景中的指定角色或可辨认的具体人物（面目清晰的人像、半身全身剪影、漫画立绘式人物均属禁忌）；不要为后续垫脸而把角色外貌写进 scenePrompt；可写远景里模糊的人群或车辆轮廓。
`;

        let historySlice = typeof buildFilteredHistorySliceForAi === 'function'
            ? buildFilteredHistorySliceForAi(chat)
            : chat.history.slice(-(chat.maxMemory || 20));

        if (provider === 'gemini') {
            const contents = historySlice.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content || '' }]
            }));
            if (!userInput) {
                contents.push({ role: 'user', parts: [{ text: '[剧场系统] 请从当前上下文继续线下剧情。' }] });
            }
            const endpoint = `${url}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(getRandomValue(key))}`;
            const headers = { 'Content-Type': 'application/json' };
            const requestBody = {
                contents,
                system_instruction: { parts: [{ text: theaterPrompt }] },
                generationConfig: { temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 0.9 }
            };
            const raw = await fetchAiResponse(db.apiSettings, requestBody, headers, endpoint, { forceNonStream: true });
            return parseTheaterJson(raw);
        }

        const messages = [{ role: 'system', content: theaterPrompt }];
        historySlice.forEach(m => messages.push({ role: m.role === 'system' ? 'user' : m.role, content: m.content || '' }));
        if (!userInput) messages.push({ role: 'user', content: '[剧场系统] 请从当前上下文继续线下剧情。' });

        const endpoint = `${url}/v1/chat/completions`;
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${getRandomValue(key)}` };
        const requestBody = {
            model,
            messages,
            temperature: db.apiSettings.temperature !== undefined ? db.apiSettings.temperature : 0.9,
            response_format: { type: 'json_object' }
        };
        const raw = await fetchAiResponse(db.apiSettings, requestBody, headers, endpoint, { forceNonStream: true });
        return parseTheaterJson(raw);
    }

    function theaterSplitIntoSentences(str) {
        const s = String(str || '').replace(/\r\n/g, '\n').trim();
        if (!s) return [];
        const paras = s.split(/\n+/).map(p => p.trim()).filter(Boolean);
        const out = [];
        for (const p of paras) {
            let start = 0;
            for (let i = 0; i < p.length; i++) {
                if ('。！？…'.includes(p[i])) {
                    const piece = p.slice(start, i + 1).trim();
                    if (piece) out.push(piece);
                    start = i + 1;
                }
            }
            const rest = p.slice(start).trim();
            if (rest) out.push(rest);
        }
        return out;
    }

    function theaterSplitLongByPause(text, maxLen) {
        const s = String(text || '').trim();
        if (!s || s.length <= maxLen) return s ? [s] : [];
        const chunks = [];
        let i = 0;
        while (i < s.length) {
            let end = Math.min(i + maxLen, s.length);
            if (end < s.length) {
                const slice = s.slice(i, end);
                const cut = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf('；'));
                if (cut > 24) end = i + cut + 1;
            }
            const piece = s.slice(i, end).trim();
            if (piece) chunks.push(piece);
            i = end;
        }
        return chunks;
    }

    function theaterChunkNarrationSentences(sentences, maxChars, maxSents) {
        const expanded = [];
        for (const sen of sentences) {
            if (sen.length > maxChars) expanded.push(...theaterSplitLongByPause(sen, maxChars));
            else expanded.push(sen);
        }
        const chunks = [];
        let cur = [];
        let len = 0;
        for (const sen of expanded) {
            if (cur.length >= maxSents || (len + sen.length > maxChars && cur.length > 0)) {
                chunks.push(cur.join(''));
                cur = [];
                len = 0;
            }
            cur.push(sen);
            len += sen.length;
        }
        if (cur.length) chunks.push(cur.join(''));
        return chunks;
    }

    /** 模型仍把多句写进一条时，按句读/字数保守拆成多条，便于一屏一点。 */
    function expandTheaterBlocksForDisplay(blocks) {
        if (!Array.isArray(blocks) || !blocks.length) return blocks;
        const out = [];
        const N_MAX = 130;
        const N_SMAX = 3;
        const D_SOFT = 88;
        const D_HARD = 120;
        for (const b of blocks) {
            if (b.type !== 'dialogue') {
                const sents = theaterSplitIntoSentences(b.text);
                if (b.text.length <= 100 && sents.length <= 2) {
                    out.push(b);
                    continue;
                }
                const parts = theaterChunkNarrationSentences(sents, N_MAX, N_SMAX);
                for (const chunk of parts) {
                    const t = chunk.trim();
                    if (t) out.push({ type: 'narration', speaker: '', text: t });
                }
                continue;
            }
            const sents = theaterSplitIntoSentences(b.text);
            if (b.text.length <= D_SOFT && sents.length <= 1) {
                out.push(b);
                continue;
            }
            if (sents.length <= 1 && b.text.length <= D_HARD) {
                out.push(b);
                continue;
            }
            const toEmit = sents.length <= 1
                ? theaterSplitLongByPause(b.text, D_SOFT)
                : sents;
            for (const seg of toEmit) {
                const t = seg.trim();
                if (!t) continue;
                out.push({ type: 'dialogue', speaker: b.speaker, text: t });
            }
        }
        return out.length ? out : blocks;
    }

    function parseTheaterJson(raw) {
        const text = String(raw || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
        try {
            return JSON.parse(text);
        } catch (e) {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                try { return JSON.parse(match[0]); } catch (_) { /* fallback below */ }
            }
        }
        return { blocks: [{ type: 'narration', text }], scenePrompt: '', sessionState: '' };
    }

    function normalizeBlocks(blocks, fallback, chat) {
        if (Array.isArray(blocks) && blocks.length) {
            const base = blocks.map(b => ({
                type: b.type === 'dialogue' ? 'dialogue' : 'narration',
                speaker: b.speaker || (b.type === 'dialogue' ? (chat.remarkName || chat.realName || chat.name) : ''),
                text: String(b.text || '').trim()
            })).filter(b => b.text);
            return expandTheaterBlocksForDisplay(base);
        }
        const text = String(fallback || '').trim();
        if (!text) return [{ type: 'narration', text: '空气短暂地安静下来。' }];
        const fromFallback = text.split(/\n{2,}/).map(p => ({ type: 'narration', text: p.trim() })).filter(b => b.text);
        return expandTheaterBlocksForDisplay(fromFallback);
    }

    function blocksToText(blocks) {
        return blocks.map(b => {
            if (b.type === 'dialogue') return `${b.speaker || '角色'}：“${b.text}”`;
            return b.text;
        }).join('\n\n');
    }

    function userTheaterBlocksToEditDraft(msg) {
        if (!msg || msg.role !== 'user') return String(msg && msg.content ? msg.content : '').trim();
        if (Array.isArray(msg.theaterUserBlocks) && msg.theaterUserBlocks.length) {
            return msg.theaterUserBlocks.map(b => (
                b.type === 'dialogue' ? `「${b.text}」` : b.text
            )).join('\n\n');
        }
        return String(msg.content || '').trim();
    }

    function assistantTheaterBlocksToEditDraft(msg) {
        if (!msg || msg.role !== 'assistant') return String(msg && msg.content ? msg.content : '').trim();
        if (Array.isArray(msg.theaterBlocks) && msg.theaterBlocks.length) {
            return blocksToText(msg.theaterBlocks);
        }
        return String(msg.content || '').trim();
    }

    function theaterImageSize() {
        const cfg = (db && db.imageGenSettings) ? db.imageGenSettings : {};
        const model = String(cfg.model || '').toLowerCase();
        if (model.includes('gpt-image')) return '1024x1536';
        return '1024x1536';
    }

    async function generateBackgroundForMessage(chat, message) {
        if (!window.ImageGenModule || !ImageGenModule.isEnabled()) {
            showBgStatus('未开启生图，已跳过背景生成。', null);
            hideBgStatusSoon();
            return;
        }
        const bgId = `theater_bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        state.imageTasks[message.id] = controller;
        message.backgroundImageStatus = 'loading';
        showBgStatus('背景生成中，可以继续阅读。', null);
        try {
            const dataUrl = await ImageGenModule.generateImageForCharacter(
                chat,
                message.scenePrompt,
                controller.signal,
                'scene',
                { size: theaterImageSize(), theaterEmptyMirror: true }
            );
            const ts = theaterState(chat);
            ts.backgrounds.push({
                id: bgId,
                sessionId: message.theaterSessionId,
                messageId: message.id,
                dataUrl,
                prompt: message.scenePrompt,
                createdAt: Date.now()
            });
            message.backgroundImageId = bgId;
            message.backgroundImageStatus = 'done';
            await saveData();
            setBackgroundImage(dataUrl);
            showBgStatus('背景已生成。', null);
            hideBgStatusSoon();
        } catch (e) {
            if (controller.signal.aborted) {
                showBgStatus('已取消本次背景生成。', null);
            } else {
                console.error('[TheaterMode ImageGen]', e);
                message.backgroundImageStatus = 'error';
                message.backgroundImageError = e.message || '生图失败';
                await saveData();
                showBgStatus(`背景生成失败：${safeText(message.backgroundImageError)}`, () => generateBackgroundForMessage(chat, message));
            }
        } finally {
            delete state.imageTasks[message.id];
        }
    }

    function renderLatestBackground(chat, sessionId) {
        const bgs = theaterState(chat).backgrounds.filter(b => b.sessionId === sessionId && b.dataUrl);
        if (bgs.length) setBackgroundImage(bgs[bgs.length - 1].dataUrl);
        else setBackgroundImage('');
    }

    function setBackgroundImage(dataUrl) {
        const bg = $('theater-bg-layer');
        if (!bg) return;
        bg.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
    }

    function showBgStatus(text, retryFn) {
        const el = $('theater-bg-status');
        if (!el) return;
        el.hidden = false;
        el.innerHTML = `<div>${safeText(text)}</div>${retryFn ? '<button type="button">重新生成背景</button>' : ''}`;
        const btn = el.querySelector('button');
        if (btn) btn.addEventListener('click', retryFn);
    }

    function hideBgStatusSoon() {
        setTimeout(() => {
            const el = $('theater-bg-status');
            if (el) el.hidden = true;
        }, 1800);
    }

    function setPawLoading(loading) {
        const paw = $('theater-paw-btn');
        if (!paw) return;
        paw.classList.toggle('loading', !!loading);
        paw.disabled = !!loading;
    }

    function setupPawDrag() {
        const paw = $('theater-paw-btn');
        if (!paw || paw._theaterDragBound) return;
        paw._theaterDragBound = true;

        paw.addEventListener('pointerdown', (e) => {
            state.drag = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                offsetX: e.clientX - paw.getBoundingClientRect().left,
                offsetY: e.clientY - paw.getBoundingClientRect().top,
                moved: false
            };
            paw.setPointerCapture(e.pointerId);
        });
        paw.addEventListener('pointermove', (e) => {
            const d = state.drag;
            if (!d || d.pointerId !== e.pointerId) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
            const screen = $(SCREEN_ID).getBoundingClientRect();
            const x = Math.max(6, Math.min(screen.width - 86, e.clientX - screen.left - d.offsetX));
            const y = Math.max(58, Math.min(screen.height - 92, e.clientY - screen.top - d.offsetY));
            paw.style.left = `${x}px`;
            paw.style.top = `${y}px`;
            paw.style.right = 'auto';
            paw.style.bottom = 'auto';
        });
        paw.addEventListener('pointerup', (e) => {
            const d = state.drag;
            state.drag = null;
            if (!d || d.pointerId !== e.pointerId) return;
            if (!d.moved) {
                paw.classList.remove('paw-bounce');
                void paw.offsetWidth;
                paw.classList.add('paw-bounce');
                paw.addEventListener('animationend', () => paw.classList.remove('paw-bounce'), { once: true });
                requestReply();
            }
        });
    }

    function openHistory() {
        const chat = currentChat();
        if (!chat) return;
        lazyEnsureSubScreens();
        ensureHistoryEditSheet($(HISTORY_SCREEN_ID));
        state.historyBrowseSessionId = null;
        mountHistoryScreen(chat);
        $(HISTORY_SCREEN_ID).classList.add('active');
        if (resolveShownHistorySession(chat)) scrollTheaterHistoryToBottom();
    }

    /** 回顾页当前应展示的场次：显式传入优先，其次用户选的 browseId，最后默认解析。 */
    function resolveShownHistorySession(chat, explicitSession = null) {
        if (explicitSession) return explicitSession;
        const bid = state.historyBrowseSessionId;
        if (bid) {
            const found = theaterState(chat).sessions.find(s => s.id === bid);
            if (found) return found;
        }
        return resolveTheaterHistorySession(chat);
    }

    function formatHistorySessionChipDate(ms) {
        const n = Number(ms);
        if (!Number.isFinite(n)) return '—';
        const d = new Date(n);
        return `${d.getMonth() + 1}/${d.getDate()}`;
    }

    function scrollTheaterHistoryToBottom() {
        const el = $('theater-history-body');
        if (!el) return;
        const run = () => {
            el.scrollTop = el.scrollHeight;
        };
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                run();
                setTimeout(run, 0);
            });
        });
    }

    function closeTheaterHistoryEdit() {
        historyEditCtx = null;
        const sheet = $(HISTORY_EDIT_SHEET_ID);
        const ta = $('theater-history-edit-textarea');
        if (ta) ta.value = '';
        if (sheet) sheet.hidden = true;
    }

    async function commitTheaterHistoryEdit() {
        const ctx = historyEditCtx;
        const ta = $('theater-history-edit-textarea');
        if (!ctx || !ta) return;
        const chat = typeof db !== 'undefined' && db.characters
            ? db.characters.find(c => c.id === ctx.chatId) : null;
        if (!chat) {
            showToast('找不到会话');
            closeTheaterHistoryEdit();
            return;
        }
        const msg = (chat.history || []).find(m => m.id === ctx.msgId);
        if (!msg || msg.mode !== 'theater') {
            showToast('找不到该条消息');
            closeTheaterHistoryEdit();
            return;
        }
        const raw = String(ta.value || '').trim();
        if (!raw) {
            showToast('内容不能为空');
            return;
        }
        const session = theaterState(chat).sessions.find(s => s.id === ctx.sessionId);
        if (!session) {
            showToast('场次无效');
            closeTheaterHistoryEdit();
            return;
        }

        if (msg.role === 'user') {
            let blocks = parseUserTheaterInput(raw);
            if (!blocks.length) blocks = [{ type: 'narration', text: raw }];
            msg.theaterUserBlocks = blocks;
            msg.content = userBlocksToContent(blocks, chat);
            msg.parts = [{ type: 'text', text: msg.content }];
        } else if (msg.role === 'assistant') {
            const blocks = normalizeBlocks(null, raw, chat);
            msg.theaterBlocks = blocks;
            msg.content = blocksToText(blocks);
            msg.parts = [{ type: 'text', text: msg.content }];
            const n = blocks.length;
            const v = Number(msg.lastViewedBlockIndex);
            if (!Number.isFinite(v) || v >= n) msg.lastViewedBlockIndex = Math.max(0, n - 1);
        }

        if (typeof saveData === 'function') await saveData();

        if (state.historyReplay && state.currentMessageId === msg.id) {
            state.historyReplay = false;
            state.playbackKind = null;
            state.currentBlocks = [];
            state.currentMessageId = null;
            state.blockIndex = 0;
            const area = $('theater-dialogue-area');
            if (area) area.hidden = true;
            updateStandees(null, null, null);
            showToast('已保存，请重新点开复盘查看');
        }

        mountHistoryScreen(chat, session);
        scrollTheaterHistoryToBottom();

        const scr = $(SCREEN_ID);
        if (scr && !scr.hidden && currentChat() && currentChat().id === chat.id) {
            renderAll(chat);
        }

        closeTheaterHistoryEdit();
    }

    function openTheaterHistoryEdit(chat, session, msg) {
        if (!chat || !session || !msg) return;
        lazyEnsureSubScreens();
        ensureHistoryEditSheet($(HISTORY_SCREEN_ID));
        historyEditCtx = { chatId: chat.id, sessionId: session.id, msgId: msg.id };
        const ta = $('theater-history-edit-textarea');
        const titleEl = $('theater-history-edit-title');
        const sheet = $(HISTORY_EDIT_SHEET_ID);
        if (!ta || !titleEl || !sheet) return;
        titleEl.textContent = msg.role === 'user' ? '编辑己方剧情' : '编辑角色剧情';
        ta.value = msg.role === 'user' ? userTheaterBlocksToEditDraft(msg) : assistantTheaterBlocksToEditDraft(msg);
        sheet.hidden = false;
        requestAnimationFrame(() => {
            ta.focus();
            const len = ta.value.length;
            ta.setSelectionRange(len, len);
        });
    }

    function ensureHistoryEditSheet(historyRoot) {
        if (!historyRoot || historyRoot.querySelector('#' + HISTORY_EDIT_SHEET_ID)) return;
        const sheet = document.createElement('div');
        sheet.id = HISTORY_EDIT_SHEET_ID;
        sheet.className = 'theater-history-edit-sheet';
        sheet.setAttribute('hidden', '');
        sheet.innerHTML = `
            <div class="theater-history-edit-backdrop" data-action="cancel-edit"></div>
            <div class="theater-history-edit-panel" role="dialog" aria-modal="true" aria-labelledby="theater-history-edit-title">
                <div class="theater-history-edit-head">
                    <span id="theater-history-edit-title">编辑剧情</span>
                    <button type="button" class="theater-icon-btn theater-history-edit-close" id="theater-history-edit-close" aria-label="关闭">✕</button>
                </div>
                <textarea id="theater-history-edit-textarea" class="theater-history-edit-textarea" rows="10" placeholder="修改正文…"></textarea>
                <div class="theater-history-edit-actions">
                    <button type="button" class="theater-history-edit-cancel" id="theater-history-edit-cancel">取消</button>
                    <button type="button" class="theater-history-edit-save" id="theater-history-edit-save">保存</button>
                </div>
            </div>
        `;
        historyRoot.appendChild(sheet);

        const cancel = () => closeTheaterHistoryEdit();
        sheet.querySelector('[data-action="cancel-edit"]').addEventListener('click', cancel);
        sheet.querySelector('#theater-history-edit-close').addEventListener('click', cancel);
        sheet.querySelector('#theater-history-edit-cancel').addEventListener('click', cancel);
        sheet.querySelector('#theater-history-edit-save').addEventListener('click', () => {
            commitTheaterHistoryEdit();
        });
    }

    function mountHistoryScreen(chat, explicitSession = null) {
        const body = $('theater-history-body');
        if (!body) return;

        const session = resolveShownHistorySession(chat, explicitSession);
        if (session) state.historyBrowseSessionId = session.id;
        else state.historyBrowseSessionId = null;

        if (!session) {
            body.innerHTML = '<div class="theater-log-item">暂无线下剧情场次。请先发送或点猫爪请求回复以开局。</div>';
            return;
        }

        const sessionsSorted = [...(theaterState(chat).sessions || [])].sort((a, b) => {
            const ta = a.endedAt || a.startedAt || 0;
            const tb = b.endedAt || b.startedAt || 0;
            return tb - ta;
        });

        const chipsHtml = sessionsSorted.length <= 1 ? '' : `
            <div class="theater-history-session-strip" role="tablist" aria-label="切换场次">
                ${sessionsSorted.map((s) => {
                    const active = s.id === session.id;
                    const label = !s.endedAt ? '进行中' : formatHistorySessionChipDate(s.endedAt || s.startedAt);
                    const sid = encodeURIComponent(s.id);
                    return `<button type="button" role="tab" aria-selected="${active}" class="theater-history-session-chip ${active ? 'active' : ''}" data-theater-history-session-id="${sid}">${safeText(label)}</button>`;
                }).join('')}
            </div>`;

        let rangeText = session.startIndex ? `本次范围：消息 ${session.startIndex}-${session.endIndex || session.startIndex}` : '未开局';
        let rangeTag = `<div class="theater-history-range-tag">${rangeText}</div>`;

        const items = theaterMessages(chat, session.id)
            .filter(m => !m.theaterBoundary)
            .map((m, i) => {
                const label = m.role === 'user' ? (chat.myName || '我') : (chat.remarkName || chat.realName || '角色');
                const isNarration = m.role === 'assistant' && m.theaterBlocks && m.theaterBlocks.every(b => String(b.type || '').toLowerCase() !== 'dialogue');
                let detail = m.content || '';
                if (m.role === 'user' && Array.isArray(m.theaterUserBlocks) && m.theaterUserBlocks.length) {
                    detail = m.theaterUserBlocks.map(b => (b.type === 'dialogue' ? `「${b.text}」` : b.text)).join('\n');
                }
                const idAttr = encodeURIComponent(m.id);
                return `
                    <div class="theater-log-item theater-log-item-replayable ${isNarration ? 'narration' : ''}" data-theater-msg-id="${idAttr}" data-role="${m.role === 'user' ? 'user' : 'assistant'}" style="animation-delay: ${i * 0.05}s" tabindex="0">
                        <button type="button" class="theater-log-edit-btn" data-theater-msg-id="${idAttr}" aria-label="编辑" title="编辑">
                            <svg class="theater-log-edit-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M17 3a2.828 2.828 0 1 1 4 4L7 21l-4 1 1-4L17 3z"/>
                            </svg>
                        </button>
                        ${isNarration ? '' : `<div class="theater-log-name">${safeText(label)}</div>`}
                        <div class="theater-log-text">${safeText(detail)}</div>
                    </div>
                `;
            }).join('') || '<div class="theater-log-item">暂无剧情记录。</div>';

        body.innerHTML = `
            ${chipsHtml}
            <div class="theater-history-timeline">
                ${items}
            </div>
            ${rangeTag}
            <button type="button" class="theater-action-btn" id="theater-journal-shortcut" style="margin-top:24px;">生成本次日记</button>
        `;

        const strip = body.querySelector('.theater-history-session-strip');
        if (strip) {
            strip.querySelectorAll('.theater-history-session-chip').forEach((btn) => {
                btn.addEventListener('click', () => {
                    let sid = '';
                    try {
                        sid = decodeURIComponent(btn.getAttribute('data-theater-history-session-id') || '');
                    } catch (_) {
                        return;
                    }
                    if (!sid || sid === state.historyBrowseSessionId) return;
                    state.historyBrowseSessionId = sid;
                    mountHistoryScreen(chat);
                    scrollTheaterHistoryToBottom();
                });
            });
            requestAnimationFrame(() => {
                const activeChip = strip.querySelector('.theater-history-session-chip.active');
                if (activeChip) activeChip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
            });
        }

        const btn = $('theater-journal-shortcut');
        if (btn) {
            btn.addEventListener('click', () => openJournalForSession(chat, session));
        }
        const timeline = body.querySelector('.theater-history-timeline');
        if (timeline) {
            timeline.addEventListener('click', (e) => {
                const editBtn = e.target.closest('.theater-log-edit-btn');
                if (editBtn && timeline.contains(editBtn)) {
                    e.preventDefault();
                    e.stopPropagation();
                    let msgId = '';
                    try {
                        msgId = decodeURIComponent(editBtn.getAttribute('data-theater-msg-id') || '');
                    } catch (_) {
                        return;
                    }
                    if (!msgId) return;
                    const msg = theaterMessages(chat, session.id).find(m => m.id === msgId);
                    if (!msg) return;
                    openTheaterHistoryEdit(chat, session, msg);
                    return;
                }
                if (e.target.closest('#theater-journal-shortcut')) return;
                const item = e.target.closest('.theater-log-item[data-theater-msg-id]');
                if (!item) return;
                e.preventDefault();
                e.stopPropagation();
                let msgId = '';
                try {
                    msgId = decodeURIComponent(item.getAttribute('data-theater-msg-id') || '');
                } catch (_) {
                    return;
                }
                if (!msgId) return;
                const msg = theaterMessages(chat, session.id).find(m => m.id === msgId);
                if (!msg) return;
                beginHistoryReplay(chat, msg, session);
            });
            timeline.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const editBtn = e.target.closest('.theater-log-edit-btn');
                if (editBtn && timeline.contains(editBtn)) {
                    e.preventDefault();
                    editBtn.click();
                    return;
                }
                const item = e.target.closest('.theater-log-item[data-theater-msg-id]');
                if (!item || !timeline.contains(item)) return;
                e.preventDefault();
                item.click();
            });
        }
    }

    function openSettings() {
        const chat = currentChat();
        if (!chat) return;
        lazyEnsureSubScreens();
        mountSettingsScreen(chat);
        $(SETTINGS_SCREEN_ID).classList.add('active');
    }

    function applyTheaterSettingFileHints(chat) {
        if (!chat) return;
        const s = theaterState(chat).settings;
        const charWrap = $('theater-char-thumb-wrap');
        const charImg = $('theater-char-thumb');
        const charNote = $('theater-char-file-note');
        if (charWrap && charImg && charNote) {
            if (s.spriteDataUrl) {
                charImg.src = s.spriteDataUrl;
                charWrap.hidden = false;
                charNote.textContent = '已保存到本角色（重新选择可替换）';
            } else {
                charWrap.hidden = true;
                charImg.removeAttribute('src');
                charNote.textContent = '点击下方「选择图片」添加立绘';
            }
        }
        const charPick = $('theater-sprite-pick-btn');
        if (charPick) charPick.textContent = s.spriteDataUrl ? '更换图片' : '选择图片';
        const userWrap = $('theater-user-thumb-wrap');
        const userImg = $('theater-user-thumb');
        const userNote = $('theater-user-file-note');
        const userPick = $('theater-user-sprite-pick-btn');
        if (userPick) userPick.textContent = s.userSpriteDataUrl ? '更换图片' : '选择图片';
        if (userWrap && userImg && userNote) {
            if (s.userSpriteDataUrl) {
                userImg.src = s.userSpriteDataUrl;
                userWrap.hidden = false;
                userNote.textContent = '已保存到本角色（重新选择可替换）';
            } else {
                userWrap.hidden = true;
                userImg.removeAttribute('src');
                userNote.textContent = '点击下方「选择图片」添加立绘';
            }
        }
    }

    function ensureTheaterExtraStyles() {
        if ($('theater-extra-style')) return;
        const s = document.createElement('style');
        s.id = 'theater-extra-style';
        s.textContent = `
            .theater-file-picker-row { margin-top: 4px; }
            .theater-file-input-hidden {
                position: absolute;
                width: 1px;
                height: 1px;
                padding: 0;
                margin: -1px;
                overflow: hidden;
                clip: rect(0, 0, 0, 0);
                white-space: nowrap;
                border: 0;
                opacity: 0;
                pointer-events: none;
            }
            .theater-file-pick-btn {
                border: 0;
                border-radius: 12px;
                padding: 10px 16px;
                background: rgba(255,255,255,.9);
                color: #211b28;
                font-weight: 750;
                font-size: 14px;
                cursor: pointer;
                -webkit-tap-highlight-color: transparent;
            }
            .theater-file-pick-btn:active { opacity: .88; }
        `;
        document.head.appendChild(s);
    }

    /** 隐藏剧场输入框滚动条（仍可用滚轮/触摸滚动），兼容仅缓存旧 theater-style 的页面 */
    function ensureTheaterInputNoScrollbarStyle() {
        if ($('theater-input-nobar-style')) return;
        const s = document.createElement('style');
        s.id = 'theater-input-nobar-style';
        s.textContent = `
            #theater-input {
                overflow-y: auto;
                scrollbar-width: none;
                -ms-overflow-style: none;
            }
            #theater-input::-webkit-scrollbar {
                display: none;
                width: 0;
                height: 0;
            }
        `;
        document.head.appendChild(s);
    }

    function mountSettingsScreen(chat) {
        const body = $('theater-settings-body');
        if (!body) return;
        const live = (typeof db !== 'undefined' && db.characters && chat
            ? db.characters.find(c => c.id === chat.id) : null) || chat;
        if (!live) return;
        const settings = theaterState(live).settings;
        
        body.innerHTML = `
            <div class="theater-polaroid-grid">
                <!-- 角色立绘 -->
                <div class="theater-polaroid-card" id="theater-sprite-card">
                    <div class="theater-polaroid-img-wrap">
                        ${settings.spriteDataUrl ? `<img src="${settings.spriteDataUrl}">` : `<div class="theater-polaroid-empty">👤<span>点击添加角色</span></div>`}
                    </div>
                    <div class="theater-polaroid-label">角色立绘</div>
                    <input type="file" id="theater-sprite-file" class="theater-file-input-hidden" accept="image/*">
                </div>
                <!-- 己方立绘 -->
                <div class="theater-polaroid-card" id="theater-user-sprite-card">
                    <div class="theater-polaroid-img-wrap">
                        ${settings.userSpriteDataUrl ? `<img src="${settings.userSpriteDataUrl}">` : `<div class="theater-polaroid-empty">📸<span>点击添加己方</span></div>`}
                    </div>
                    <div class="theater-polaroid-label">己方立绘</div>
                    <input type="file" id="theater-user-sprite-file" class="theater-file-input-hidden" accept="image/*">
                </div>
            </div>

            <div class="theater-sprite-tune">
                <div class="theater-tune-head">剧中立绘微调（每场可不同图，换图后可再调）</div>
                <div class="theater-tune-grid">
                    <div class="theater-tune-card">
                        <div class="theater-tune-title">角色</div>
                        <label class="theater-slider-label">上下 <span id="theater-char-off-val">0</span> px</label>
                        <input type="range" class="theater-range-input" id="theater-char-offset-y" min="-380" max="200" step="2" value="${Number(settings.spriteOffsetY) || 0}">
                        <label class="theater-slider-label">缩放 <span id="theater-char-sc-val">100</span>%</label>
                        <input type="range" class="theater-range-input" id="theater-char-scale" min="65" max="140" step="1" value="${Math.round((Number(settings.spriteScale) || 1) * 100)}">
                    </div>
                    <div class="theater-tune-card">
                        <div class="theater-tune-title">己方</div>
                        <label class="theater-slider-label">上下 <span id="theater-user-off-val">0</span> px</label>
                        <input type="range" class="theater-range-input" id="theater-user-offset-y" min="-380" max="200" step="2" value="${Number(settings.userSpriteOffsetY) || 0}">
                        <label class="theater-slider-label">缩放 <span id="theater-user-sc-val">100</span>%</label>
                        <input type="range" class="theater-range-input" id="theater-user-scale" min="65" max="140" step="1" value="${Math.round((Number(settings.userSpriteScale) || 1) * 100)}">
                    </div>
                </div>
            </div>

            <div class="theater-form-row">
                <label>自动生成背景</label>
                <div class="theater-toggle ${settings.generateBackground ? 'on' : ''}" id="theater-bg-enabled"></div>
            </div>
            
            <div style="margin-top:32px;">
                <button type="button" class="theater-action-btn" id="theater-open-gallery">背景图册</button>
                <button type="button" class="theater-action-btn btn-danger" id="theater-end-session">结束本次线下</button>
            </div>
        `;

        $('theater-sprite-card').addEventListener('click', () => $('theater-sprite-file').click());
        $('theater-user-sprite-card').addEventListener('click', () => $('theater-user-sprite-file').click());

        $('theater-bg-enabled').addEventListener('click', (e) => {
            const t = e.currentTarget;
            t.classList.toggle('on');
            settings.generateBackground = t.classList.contains('on');
            saveData();
        });

        $('theater-open-gallery').addEventListener('click', openGallery);
        $('theater-end-session').addEventListener('click', endSession);

        const charOffEl = $('theater-char-offset-y');
        const charScEl = $('theater-char-scale');
        const userOffEl = $('theater-user-offset-y');
        const userScEl = $('theater-user-scale');
        const refreshTuneLabels = () => {
            const cOff = $('theater-char-off-val');
            const cSc = $('theater-char-sc-val');
            const uOff = $('theater-user-off-val');
            const uSc = $('theater-user-sc-val');
            if (cOff) cOff.textContent = String(Math.round(Number(settings.spriteOffsetY) || 0));
            if (cSc) cSc.textContent = String(Math.round((Number(settings.spriteScale) || 1) * 100));
            if (uOff) uOff.textContent = String(Math.round(Number(settings.userSpriteOffsetY) || 0));
            if (uSc) uSc.textContent = String(Math.round((Number(settings.userSpriteScale) || 1) * 100));
        };
        refreshTuneLabels();
        const applyTuneToMain = () => refreshTheaterSpritesOnly(live);
        if (charOffEl) {
            charOffEl.addEventListener('input', () => {
                settings.spriteOffsetY = clampSpriteOffset(+charOffEl.value);
                refreshTuneLabels();
                saveData();
                applyTuneToMain();
            });
        }
        if (charScEl) {
            charScEl.addEventListener('input', () => {
                settings.spriteScale = clampSpriteScale(+charScEl.value / 100);
                refreshTuneLabels();
                saveData();
                applyTuneToMain();
            });
        }
        if (userOffEl) {
            userOffEl.addEventListener('input', () => {
                settings.userSpriteOffsetY = clampSpriteOffset(+userOffEl.value);
                refreshTuneLabels();
                saveData();
                applyTuneToMain();
            });
        }
        if (userScEl) {
            userScEl.addEventListener('input', () => {
                settings.userSpriteScale = clampSpriteScale(+userScEl.value / 100);
                refreshTuneLabels();
                saveData();
                applyTuneToMain();
            });
        }

        $('theater-sprite-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const dataUrl = await compressImageOrRead(file);
                theaterState(live).settings.spriteDataUrl = dataUrl;
                await saveData();
                if ($(SCREEN_ID) && !$(SCREEN_ID).hidden) renderAll(live);
                mountSettingsScreen(live);
                showToast('角色立绘已保存');
            } catch(err) { showToast('保存失败'); }
        });
        $('theater-user-sprite-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const dataUrl = await compressImageOrRead(file);
                theaterState(live).settings.userSpriteDataUrl = dataUrl;
                await saveData();
                if ($(SCREEN_ID) && !$(SCREEN_ID).hidden) renderAll(live);
                mountSettingsScreen(live);
                showToast('己方立绘已保存');
            } catch(err) { showToast('保存失败'); }
        });
    }
    
    async function compressImageOrRead(file) {
        if (typeof compressImage === 'function') return compressImage(file, { maxWidth: 1200, maxHeight: 1600, quality: 0.9, preserveAlpha: true });
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function openGallery() {
        const chat = currentChat();
        if (!chat) return;
        lazyEnsureSubScreens();
        mountGalleryScreen(chat);
        $(GALLERY_SCREEN_ID).classList.add('active');
    }

    function mountGalleryScreen(chat) {
        const body = $('theater-gallery-body');
        if (!body) return;
        const sessionId = state.sessionId;
        const bgs = theaterState(chat).backgrounds.filter(b => !sessionId || b.sessionId === sessionId);
        const html = bgs.length ? `
            <div class="theater-gallery-grid">
                ${bgs.map(b => `
                    <div class="theater-gallery-card" data-id="${b.id}">
                        <img src="${b.dataUrl}" alt="">
                        <button type="button" data-action="delete-bg" data-id="${b.id}">删除</button>
                    </div>
                `).join('')}
            </div>
        ` : '<div class="theater-log-item">还没有生成背景图。</div>';
        body.innerHTML = html;
        document.querySelectorAll('#theater-gallery-body [data-action="delete-bg"]').forEach(btn => {
            btn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const id = btn.dataset.id;
                if (!confirm('确定删除这张背景图吗？删除后会从存储中移除。')) return;
                const ts = theaterState(chat);
                ts.backgrounds = ts.backgrounds.filter(b => b.id !== id);
                (chat.history || []).forEach(m => {
                    if (m.backgroundImageId === id) delete m.backgroundImageId;
                });
                await saveData();
                mountGalleryScreen(chat);
                renderLatestBackground(chat, state.sessionId);
            });
        });
        document.querySelectorAll('#theater-gallery-body .theater-gallery-card img').forEach(img => {
            img.addEventListener('click', () => {
                if (typeof openImageViewer === 'function') openImageViewer(img.src);
            });
        });
    }

    /** 离开剧场相关页面前的收纳：避免 absolute 子屏仍叠在日记等页面上 */
    function dismissTheaterSubScreens() {
        const ids = [SETTINGS_SCREEN_ID, HISTORY_SCREEN_ID, GALLERY_SCREEN_ID];
        ids.forEach(id => {
            const el = $(id);
            if (el) el.classList.remove('active');
        });
        closeTheaterHistoryEdit();
    }

    function openJournalForSession(chat, session) {
        const start = session.startIndex;
        const end = session.endIndex || start;
        if (!start || !end || end < start) {
            showToast('本次剧情还没有可总结内容');
            return;
        }
        dismissTheaterSubScreens();
        switchScreen('memory-journal-screen');
        if (typeof renderJournalList === 'function') renderJournalList();
        if (typeof openGenerateJournalModal === 'function') {
            openGenerateJournalModal({
                prefill: {
                    chatId: currentChatId,
                    chatType: currentChatType,
                    start,
                    end,
                    includeFavorited: false
                }
            });
        }
    }

    async function endSession() {
        const chat = currentChat();
        if (!chat) return;
        const ts = theaterState(chat);
        const session = ts.sessions.find(s => s.id === ts.activeSessionId && !s.endedAt);
        if (!session) {
            showToast('当前没有进行中的线下剧情');
            return;
        }
        if (!confirm('确定结束本次线下剧情吗？结束后回线上会按“线下已结束”衔接。')) return;
        session.endedAt = Date.now();
        session.endIndex = (chat.history || []).length + 1;
        chat.history.push({
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            role: 'user',
            content: '[system: 本次线下剧场已结束。之后恢复线上即时聊天，但需要记得线下发生的事。]',
            parts: [{ type: 'text', text: '[system: 本次线下剧场已结束。之后恢复线上即时聊天，但需要记得线下发生的事。]' }],
            timestamp: Date.now(),
            mode: 'theater',
            theaterBoundary: 'end',
            theaterSessionId: session.id
        });
        ts.activeSessionId = null;
        await saveData();
        switchScreen('chat-room-screen');
        showToast('本次线下已结束');
    }

    return { open };
})();

window.TheaterMode = TheaterMode;
