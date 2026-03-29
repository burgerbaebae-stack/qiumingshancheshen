/**
 * TTS 语音系统核心引擎
 * 文件：js/modules/tts.js
 *
 * 职责：
 *   1. 全局 TTS 配置的加载与保存
 *   2. 向 OpenAI 兼容的 TTS 接口发起合成请求
 *   3. 音频播放管理（播放/停止，始终从 0 秒起）
 *   4. 语音气泡的 TTS 播放集成
 *   5. 通话流式 TTS（Stream 逐句入队、顺序发声）
 *   6. 角色专属语音参数的存取
 *   7. TTS 预设管理
 *
 * ⚠️  此文件是"发电机"，禁止在其他核心文件中放置音频逻辑。
 */

const TTSModule = (() => {

    /* ──────────────────────────────────────────────────────────────
       内部状态
    ────────────────────────────────────────────────────────────── */

    // 全局唯一播放器实例：用于 iOS/Safari 自动播放解锁与后续所有播放复用
    const globalAudio = new Audio();

    const state = {
        currentAudio: null,       // 当前正在播放的 Audio 对象
        currentAudioUrl: null,    // 当前 ObjectURL（需要手动释放）
        currentBubbleEl: null,    // 当前正在播放的气泡 DOM 元素

        callAudioUnlocked: false, // 通话中是否已通过用户手势解锁自动播放
        callAudioQueue: [],       // 通话流式队列：[{ text, voiceId, speed, volume }]
        callStreamBuffer: '',     // 未处理完的流式文本片段
        isCallStreamPlaying: false, // 通话队列是否正在消费中

        // 单次 AI 通话回复：原始流累积 + 已入队的语音块数（与档案室 parse 规则一致）
        callReplyRawBuffer: '',
        callReplyEmittedVoiceCount: 0,
        // AI 语音气泡按顺序领取 synthesize 时生成的 ttsAudioId（与 pending 入队一一对应）
        pendingVoiceTtsIds: [],

        // 简单的页面级内存缓存：key -> Blob（音频数据）
        ttsCache: new Map(),

        // iOS / Safari 是否已通过用户手势为 globalAudio 完成解锁
        _appleAudioUnlocked: false,
    };

    /* ──────────────────────────────────────────────────────────────
       iOS / Safari 音频解锁（必须由用户手势驱动）
    ────────────────────────────────────────────────────────────── */

    /**
     * 在用户物理点击的同步栈中调用，用 globalAudio 播放极短静音，
     * 去“唤醒”苹果系的自动播放拦截。
     *
     * 注意：只能做一次轻量操作，必须是同步执行，不能 await。
     */
    function unlockAppleAudio() {
        // 已解锁过则不重复触发，避免多次创建上下文
        if (state._appleAudioUnlocked) return;

        try {
            // 使用同一个全局播放器播放极短静音，建立可信的用户手势链路
            const silentSrc = 'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA' +
                              'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
            globalAudio.muted = true;
            globalAudio.loop = true; // 无限循环静音，占位苹果音频通道
            if (globalAudio.src !== silentSrc) {
                globalAudio.src = silentSrc;
            }
            // 不关心返回 Promise，只要同步调用链触发即可
            globalAudio.play().catch(() => {});
            state._appleAudioUnlocked = true;
        } catch (e) {
            // 兜底：如果连这里都失败，就保持静默，避免影响主流程
        }
    }

    /* ──────────────────────────────────────────────────────────────
       配置读写辅助（localStorage 本地存储，确保刷新后数据不丢失）
    ────────────────────────────────────────────────────────────── */

    const TTS_STORAGE_KEY   = 'tts_settings';
    const TTS_PRESETS_KEY   = 'tts_presets';

    function getConfig() {
        try {
            const raw = localStorage.getItem(TTS_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') return parsed;
            }
        } catch (_) {}
        // 兼容：若 localStorage 无数据，从 db 迁移后写入
        const fromDb = (typeof db !== 'undefined' && db.ttsSettings) ? db.ttsSettings : {};
        if (Object.keys(fromDb).length > 0) {
            try { localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(fromDb)); } catch (_) {}
            return fromDb;
        }
        return {};
    }

    function isGlobalEnabled() {
        return !!getConfig().globalEnabled;
    }

    /** 判断某个角色是否启用了专属语音（全局 + 角色双开关同时开启） */
    function isCharEnabled(chat) {
        if (!isGlobalEnabled()) return false;
        return !!(chat && chat.ttsEnabled);
    }

    /* ──────────────────────────────────────────────────────────────
       TTS 内存缓存辅助
    ────────────────────────────────────────────────────────────── */

    const TTS_CACHE_MAX_ENTRIES = 100;

    /** 非通话气泡等场景：无稳定 ID 时的去重键（通话合成一律使用 ttsAudioId，禁止用此文本质押） */
    function getTtsCacheKey(text, voiceId, speed, model) {
        return `${model || ''}__${voiceId || ''}__${speed ?? ''}__${text}`;
    }

    function newTtsAudioId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 'tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
    }

    function getFromTtsCache(key) {
        return state.ttsCache.get(key) || null;
    }

    function saveToTtsCache(key, blob) {
        if (!blob) return;
        if (state.ttsCache.size >= TTS_CACHE_MAX_ENTRIES) {
            const firstKey = state.ttsCache.keys().next().value;
            if (firstKey) state.ttsCache.delete(firstKey);
        }
        state.ttsCache.set(key, blob);
    }

    /* ──────────────────────────────────────────────────────────────
       核心合成请求（通过 Vercel 代理调用 MiniMax TTS）
    ────────────────────────────────────────────────────────────── */

    /**
     * @param {object} [synthOptions]
     * @param {string} [synthOptions.cacheId] - 若提供，仅按此 ID 读写缓存（通话气泡绑定）；不提供则沿用文本去重键（语音气泡/测试等）
     */
    async function synthesize(text, voiceId, speed, synthOptions = {}) {
        const cfg = getConfig();
        const apiUrl = (cfg.apiUrl || '').trim();   // 用户在前端填写的 MiniMax TTS 接口地址
        const apiKey = (cfg.apiKey || '').trim();
        const groupId = (cfg.groupId || '').trim();

        if (!apiUrl || !apiKey) {
            throw new Error('TTS未配置接口地址或 API 密钥，请先在 API 设置页面完成 TTS 配置。');
        }

        const model = cfg.model || 'speech-2.8-turbo';
        const finalVoiceId = voiceId || cfg.defaultVoiceId || 'male-qn-qingse';
        const finalSpeed   = speed !== undefined ? Number(speed) : (cfg.defaultSpeed || 1.0);
        const cacheId = synthOptions && synthOptions.cacheId ? String(synthOptions.cacheId) : '';

        if (cacheId) {
            const byId = getFromTtsCache(cacheId);
            if (byId) return byId;
        } else {
            const cacheKey = getTtsCacheKey(text, finalVoiceId, finalSpeed, model);
            const cached = getFromTtsCache(cacheKey);
            if (cached) return cached;
        }

        // 调用同源的 Vercel 代理，由代理再请求 MiniMax
        const proxyEndpoint = '/api/minimax-tts';

        const body = {
            apiUrl,
            apiKey,
            groupId,
            model,
            text,
            voiceId: finalVoiceId,
            // MiniMax 的 speed 建议区间 [0.25, 4]，与 UI 拉杆保持一致
            speed: finalSpeed,
        };

        const headers = {
            'Content-Type': 'application/json',
        };

        const response = await fetch(proxyEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try { errMsg += `: ${await response.text()}`; } catch (_) {}
            throw new Error(`TTS合成失败 — ${errMsg}`);
        }

        // 代理会直接转发 MiniMax 返回的 JSON，一般形如：
        // { "base_resp": { status_code, status_msg }, "data": { "audio": "<hex string>" } }
        const json = await response.json();

        // 如果 MiniMax 使用 base_resp 表示业务错误，优先抛出它的提示
        if (json && json.base_resp && json.base_resp.status_code && json.base_resp.status_code !== 0) {
            const code = json.base_resp.status_code;
            const msg  = json.base_resp.status_msg || '未知错误';
            throw new Error(`MiniMax TTS 错误（${code}）：${msg}`);
        }

        const hex = json && json.data && json.data.audio;
        if (!hex || typeof hex !== 'string') {
            // 尝试输出更多原始信息，方便排查 voiceId 等参数问题
            throw new Error('TTS接口返回数据异常（未找到音频字段），原始响应：' + JSON.stringify(json));
        }

        const len = hex.length / 2;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        const blob = new Blob([bytes], { type: 'audio/mpeg' });

        if (cacheId) {
            saveToTtsCache(cacheId, blob);
        } else {
            saveToTtsCache(getTtsCacheKey(text, finalVoiceId, finalSpeed, model), blob);
        }

        return blob;
    }

    /**
     * 档案室 / 通话重听：仅按气泡绑定的 ttsAudioId 取缓存播放，绝不因文本再请求 MiniMax。
     */
    async function playCallAudioById(ttsAudioId, chat, options = {}) {
        if (!ttsAudioId || !chat) return;

        if (!isCharEnabled(chat)) {
            if (typeof showToast === 'function') {
                showToast(isGlobalEnabled() ? '该角色未开启专属语音' : 'TTS全局开关未开启');
            }
            const onEnded = typeof options.onEnded === 'function' ? options.onEnded : null;
            if (onEnded) onEnded();
            return;
        }

        const volume = options.volume !== undefined ? options.volume : 1.0;
        const onEnded = typeof options.onEnded === 'function' ? options.onEnded : null;
        const blob = getFromTtsCache(ttsAudioId);

        if (!blob) {
            if (typeof showToast === 'function') {
                showToast('暂无本条语音缓存，可能尚未合成或已被清理');
            }
            if (onEnded) onEnded();
            return;
        }

        const sub = options.subtitleText != null ? String(options.subtitleText) : '';
        _setCallCinemaSubtitle(sub);
        await _playBlob(blob, null, volume, () => {
            _setCallCinemaSubtitle('');
            if (onEnded) onEnded();
        });
    }

    /** 新一段 AI 流式回复开始前清空方括号解析状态（由 VideoCallModule 在拉流前调用） */
    function beginCallAiReplyTurn() {
        state.callReplyRawBuffer = '';
        state.callReplyEmittedVoiceCount = 0;
        state.pendingVoiceTtsIds = [];
    }

    /** AI 语音气泡 addMessage 时按顺序领取与入队时 push 的 id */
    function takePendingVoiceTtsId() {
        const id = state.pendingVoiceTtsIds.shift();
        return id || null;
    }

    /** 用户语音气泡：首次用 id 合成并写入缓存，供重听只走 ID */
    function prefetchCallUserLineAudio(ttsAudioId, text, chat) {
        if (!ttsAudioId || !text || !chat) return;
        if (!isCharEnabled(chat)) return;
        const cfg = getConfig();
        const voiceId = chat.ttsVoiceId || cfg.defaultVoiceId || 'male-qn-qingse';
        const speed = chat.ttsSpeed !== undefined ? chat.ttsSpeed : (cfg.defaultSpeed || 1.0);
        void synthesize(text, voiceId, speed, { cacheId: ttsAudioId }).catch((e) => {
            console.error('[TTS prefetch user line]', e);
        });
    }

    /**
     * 与 VideoCallModule.parseAndAddAiResponse 使用同一套方括号规则，提取「非画面/环境/动作」的语音块正文（顺序一致）。
     */
    function extractVoiceBlockContentsFromRawAi(text) {
        if (!text) return [];
        const regex = /\[(.*?)[：:]([\s\S]+?)\]/g;
        const out = [];
        let m;
        while ((m = regex.exec(text)) !== null) {
            const tag = m[1] || '';
            if (tag.includes('画面') || tag.includes('环境') || tag.includes('动作')) continue;
            out.push((m[2] || '').trim());
        }
        return out;
    }

    /* ──────────────────────────────────────────────────────────────
       播放控制
    ────────────────────────────────────────────────────────────── */

    /** 停止当前音频并清理资源（不销毁 globalAudio 实例本身） */
    function stopCurrent() {
        if (state.currentAudio) {
            state.currentAudio.pause();
            state.currentAudio.currentTime = 0;
            state.currentAudio.onended = null;
        }
        if (state.currentAudioUrl) {
            URL.revokeObjectURL(state.currentAudioUrl);
            state.currentAudioUrl = null;
        }
        if (state.currentBubbleEl) {
            state.currentBubbleEl.classList.remove('tts-playing', 'tts-loading');
            state.currentBubbleEl = null;
        }
    }

    /**
     * 使用全局唯一的 Audio 实例播放 Blob。
     * @param {Blob}       blob     - 音频数据
     * @param {HTMLElement|null} bubbleEl - 语音气泡 DOM（可为 null）
     * @param {number}     volume   - 音量 0~1
     * @param {Function}   onEnded  - 播放结束回调
     */
    async function _playBlob(blob, bubbleEl, volume, onEnded) {
        // 先停止上一次播放，但不销毁 globalAudio
        stopCurrent();

        const url = URL.createObjectURL(blob);

        // 复用同一个 globalAudio 实例，绕过 iOS/Safari 自动播放限制
        state.currentAudio    = globalAudio;
        state.currentAudioUrl = url;
        state.currentBubbleEl = bubbleEl || null;

        if (bubbleEl) {
            bubbleEl.classList.add('tts-playing');
        }

        // 确保真正播放时是非静音的
        globalAudio.muted = false;
        globalAudio.loop = false; // 播放真实语音前关闭静音循环
        globalAudio.volume = (volume !== undefined && !isNaN(volume))
            ? Math.min(1, Math.max(0, volume))
            : 1.0;
        globalAudio.src = url;

        globalAudio.onended = () => {
            URL.revokeObjectURL(url);
            if (state.currentAudioUrl === url) {
                state.currentAudioUrl = null;
            }
            if (state.currentBubbleEl === bubbleEl && bubbleEl) {
                bubbleEl.classList.remove('tts-playing');
                state.currentBubbleEl = null;
            }
            if (typeof onEnded === 'function') onEnded();
        };

        await globalAudio.play();
        return globalAudio;
    }

    /* ──────────────────────────────────────────────────────────────
       语音气泡 TTS 集成（Task 3）
    ────────────────────────────────────────────────────────────── */

    /**
     * 点击语音气泡播放按钮时调用。
     * 若当前正在播放同一气泡 → 停止；否则合成并播放。
     *
     * @param {string}     text     - 要合成的文本
     * @param {object}     chat     - 角色对象（含 ttsEnabled, ttsVoiceId 等）
     * @param {HTMLElement} bubbleEl - .voice-bubble 元素
     */
    async function playVoiceBubble(text, chat, bubbleEl) {
        if (!isCharEnabled(chat)) {
            if (typeof showToast === 'function') {
                showToast(isGlobalEnabled() ? '该角色未开启专属语音' : 'TTS全局开关未开启');
            }
            return;
        }

        // 如果正在播放同一气泡 → 停止
        if (state.currentBubbleEl === bubbleEl && state.currentAudio) {
            stopCurrent();
            return;
        }

        // 停掉上一个，开始新播放
        stopCurrent();

        try {
            bubbleEl.classList.add('tts-loading');
            const voiceId = chat.ttsVoiceId || '';
            const speed   = chat.ttsSpeed !== undefined ? chat.ttsSpeed : 1.0;
            const blob = await synthesize(text, voiceId, speed);
            bubbleEl.classList.remove('tts-loading');
            await _playBlob(blob, bubbleEl, 1.0, null);
        } catch (err) {
            bubbleEl.classList.remove('tts-loading');
            console.error('[TTS Voice Bubble]', err);
            if (typeof showToast === 'function') showToast('TTS合成失败：' + err.message);
        }
    }

    /* ──────────────────────────────────────────────────────────────
       通话流式 TTS（Task 4）
    ────────────────────────────────────────────────────────────── */

    /** 用户点击"接通"时调用，通过真实手势授权自动播放 */
    function unlockCallAudio() {
        state.callAudioUnlocked  = true;
        state.callAudioQueue     = [];
        state.callStreamBuffer   = '';
        state.isCallStreamPlaying = false;
        beginCallAiReplyTurn();
        _showCallIndicator(false);
        _setCallCinemaSubtitle('');
    }

    /** 通话结束时重置状态 */
    function resetCallStream() {
        state.callAudioQueue      = [];
        state.callStreamBuffer    = '';
        state.isCallStreamPlaying = false;
        state.callAudioUnlocked   = false;
        beginCallAiReplyTurn();
        stopCurrent();
        _showCallIndicator(false);
        _setCallCinemaSubtitle('');
    }

    /**
     * 对已经过状态机过滤后的文本做轻量清洗：
     *   - 仅合并多余空白并裁剪首尾空格，不再做任何正则级别的复杂删除，避免误杀。
     */
    function cleanCallText(text) {
        if (!text) return '';
        return String(text)
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    /**
     * 接收流式文本块（chunk），从通话 AI 回复流中调用。
     * 与档案室 parse 一致：仅当完整 `[标签：内容]` 闭合且为语音块时入队，并为该段分配 ttsAudioId 写入 pending 供气泡绑定。
     */
    async function feedCallChunk(chunk) {
        if (!state.callAudioUnlocked) return;
        const chat = _getCallChat();
        if (!isCharEnabled(chat)) return;

        state.callReplyRawBuffer += chunk;
        const voiceContents = extractVoiceBlockContentsFromRawAi(state.callReplyRawBuffer);

        while (state.callReplyEmittedVoiceCount < voiceContents.length) {
            const rawLine = voiceContents[state.callReplyEmittedVoiceCount];
            state.callReplyEmittedVoiceCount += 1;

            const id = newTtsAudioId();
            state.pendingVoiceTtsIds.push(id);

            const clean = cleanCallText(rawLine);
            if (clean.length > 0) {
                state.callAudioQueue.push(_buildCallItem(clean, chat, id));
            }
        }

        if (state.isCallStreamPlaying) {
            _preloadCallQueueHead(4);
        } else {
            _processCallQueue();
        }
    }

    /** 流式回复结束时调用：唤醒队列消费（语音块仅在括号闭合时入队，无旧版 sentence flush） */
    async function flushCallBuffer() {
        if (!state.callAudioUnlocked) return;
        const chat = _getCallChat();
        if (!isCharEnabled(chat)) return;

        state.callStreamBuffer = '';

        if (state.isCallStreamPlaying) {
            _preloadCallQueueHead(4);
        } else {
            _processCallQueue();
        }
    }

    function _buildCallItem(text, chat, ttsAudioId) {
        const cfg = getConfig();
        const model = cfg.model || 'speech-2.8-turbo';
        const voiceId = chat.ttsVoiceId || cfg.defaultVoiceId || 'male-qn-qingse';
        const speed = chat.ttsSpeed !== undefined ? chat.ttsSpeed : (cfg.defaultSpeed || 1.0);
        return {
            text,
            voiceId,
            speed,
            model,
            volume: 1.0,
            blob: null,
            blobPromise: null,
            ttsAudioId: ttsAudioId || null,
        };
    }

    function _getCallChat() {
        return (typeof VideoCallModule !== 'undefined' &&
                VideoCallModule.state &&
                VideoCallModule.state.currentChat)
            ? VideoCallModule.state.currentChat
            : null;
    }

    /** 新主卧电影字幕：仅 textContent 硬切，无过渡 */
    function _setCallCinemaSubtitle(text) {
        if (typeof VideoCallModule !== 'undefined' &&
            typeof VideoCallModule.setCinemaSubtitle === 'function') {
            VideoCallModule.setCinemaSubtitle(text);
        }
    }

    /**
     * 确保队列项已完成合成：
     *   - 若已有 blob，直接返回
     *   - 若有 blobPromise，等待其完成
     *   - 否则新建 synthesize Promise 并缓存
     */
    async function _ensureItemBlob(item) {
        if (item.blob) return item.blob;
        if (!item.blobPromise) {
            item.blobPromise = synthesize(item.text, item.voiceId, item.speed, {
                cacheId: item.ttsAudioId || undefined,
            })
                .then((b) => {
                    item.blob = b;
                    return b;
                })
                .catch((e) => {
                    // 失败时清理，避免卡死在坏 Promise 上
                    item.blobPromise = null;
                    throw e;
                });
        }
        return item.blobPromise;
    }

    /**
     * 后台预热队列前若干条（不 await），用于压缩句与句之间的空窗。
     * 流式入队在「正在播放」时不会再次进入 _processCallQueue，必须在 feed/flush 时主动 kick。
     */
    function _preloadCallQueueHead(maxAhead) {
        const q = state.callAudioQueue;
        const n = Math.min(Math.max(1, maxAhead || 4), q.length);
        for (let i = 0; i < n; i++) {
            void _ensureItemBlob(q[i]).catch((e) => {
                console.error('[TTS Call Queue Preload]', e);
            });
        }
    }

    /**
     * 通话队列消费：
     *   - 当前项使用已预加载或现合成的 blob 播放
     *   - 同时后台预加载下一项，减少段与段之间的停顿
     */
    async function _processCallQueue() {
        if (state.callAudioQueue.length === 0) {
            state.isCallStreamPlaying = false;
            _showCallIndicator(false);
            _setCallCinemaSubtitle('');
            return;
        }
        state.isCallStreamPlaying = true;
        _showCallIndicator(true);

        const item = state.callAudioQueue.shift();

        // 当前条播放期间并行预热后续多条（移动网络下合成较慢，多 lookahead 可明显减少句间停顿）
        _preloadCallQueueHead(4);

        try {
            const blob = await _ensureItemBlob(item);
            _setCallCinemaSubtitle(item.text);
            await _playBlob(blob, null, item.volume, () => {
                _processCallQueue();
            });
        } catch (err) {
            console.error('[TTS Call Queue]', err);
            // 跳过失败项，继续处理下一条
            _processCallQueue();
        }
    }

    /** 控制通话界面底部 TTS 状态指示器 */
    function _showCallIndicator(visible) {
        const el = document.getElementById('vc-tts-indicator');
        if (!el) return;
        el.classList.toggle('visible', visible);
    }

    /* ──────────────────────────────────────────────────────────────
       测试 TTS（Task 1 底部按钮）
    ────────────────────────────────────────────────────────────── */

    async function testTTS() {
        const btn = document.getElementById('tts-test-btn');
        if (btn) btn.classList.add('loading');
        try {
            if (!isGlobalEnabled()) {
                if (typeof showToast === 'function') showToast('请先开启 TTS 全局总开关');
                return;
            }
            const cfg = getConfig();
            if (!cfg.apiUrl || !cfg.apiKey) {
                if (typeof showToast === 'function') showToast('请先填写 TTS 接口地址和密钥');
                return;
            }
            if (typeof showToast === 'function') showToast('正在合成，请稍候…');
            // 这里同样走 synthesize（内部已改为调用 /api/minimax-tts 代理）
            const blob = await synthesize('测试成功', cfg.defaultVoiceId || 'alloy', 1.0);
            await _playBlob(blob, null, 1.0, null);
        } catch (err) {
            console.error('[TTS Test]', err);
            if (typeof showToast === 'function') {
                // 继续保留对 CORS/网络错误的友好提示，但此时错误主要来自代理或上游接口
                if (err && err.name === 'TypeError' && /Failed to fetch/i.test(err.message || '')) {
                    showToast('TTS测试失败：无法通过代理访问 TTS 接口，请检查网络连通性或代理部署是否正确。');
                } else {
                    showToast('TTS测试失败：' + err.message);
                }
            }
        } finally {
            if (btn) btn.classList.remove('loading');
        }
    }

    /* ──────────────────────────────────────────────────────────────
       TTS 预设管理（Task 1）
    ────────────────────────────────────────────────────────────── */

    function _getPresets() {
        try {
            const raw = localStorage.getItem(TTS_PRESETS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (_) {}
        const fromDb = (typeof db !== 'undefined' && db.ttsPresets) ? db.ttsPresets : [];
        if (fromDb.length > 0) {
            try { localStorage.setItem(TTS_PRESETS_KEY, JSON.stringify(fromDb)); } catch (_) {}
            return fromDb;
        }
        return [];
    }

    function _savePresets(arr) {
        const list = arr || [];
        try { localStorage.setItem(TTS_PRESETS_KEY, JSON.stringify(list)); } catch (_) {}
        if (typeof db !== 'undefined') db.ttsPresets = list;
        if (typeof saveData === 'function') saveData();
    }

    function populatePresetSelect() {
        const sel = document.getElementById('tts-preset-select');
        if (!sel) return;
        const presets = _getPresets();
        sel.innerHTML = '<option value="">— 选择 TTS 预设 —</option>';
        presets.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            sel.appendChild(opt);
        });
    }

    function savePreset() {
        const name = prompt('请输入预设名称：');
        if (!name || !name.trim()) return;
        const cfg = getConfig();
        const presets = _getPresets();
        const idx = presets.findIndex(p => p.name === name.trim());
        const entry = { name: name.trim(), ...cfg };
        if (idx >= 0) presets[idx] = entry;
        else presets.push(entry);
        _savePresets(presets);
        populatePresetSelect();
        const sel = document.getElementById('tts-preset-select');
        if (sel) sel.value = name.trim();
        if (typeof showToast === 'function') showToast('TTS 预设已保存！');
    }

    function applyPreset() {
        const sel = document.getElementById('tts-preset-select');
        if (!sel || !sel.value) {
            if (typeof showToast === 'function') showToast('请先选择一个预设');
            return;
        }
        const presets = _getPresets();
        const entry = presets.find(p => p.name === sel.value);
        if (!entry) return;
        const { name, ...cfg } = entry;
        const merged = { ...getConfig(), ...cfg };
        try { localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(merged)); } catch (_) {}
        if (typeof db !== 'undefined') db.ttsSettings = merged;
        if (typeof saveData === 'function') saveData();
        loadToUI();
        if (typeof showToast === 'function') showToast('TTS 预设已应用！');
    }

    function deleteCurrentPreset() {
        // 保留旧函数签名以避免潜在调用报错，但内部委托给新的预设管理弹窗
        openPresetManager();
    }

    /**
     * 打开预设管理弹窗：展示当前所有预设及垃圾桶删除按钮
     */
    function openPresetManager() {
        const modal = document.getElementById('tts-preset-modal');
        const list = document.getElementById('tts-preset-list');
        const empty = document.getElementById('tts-preset-empty');
        if (!modal || !list || !empty) return;

        list.innerHTML = '';
        const presets = _getPresets();
        if (!presets.length) {
            empty.style.display = 'block';
        } else {
            empty.style.display = 'none';
            presets.forEach(p => {
                const row = document.createElement('div');
                row.className = 'tts-preset-row';
                row.innerHTML = `
                    <span class="tts-preset-name">${p.name}</span>
                    <button type="button" class="tts-preset-delete-btn" aria-label="删除预设">
                        🗑
                    </button>
                `;
                const delBtn = row.querySelector('.tts-preset-delete-btn');
                delBtn.addEventListener('click', () => {
                    if (!confirm('确定是否删除？')) return;
                    const updated = _getPresets().filter(item => item.name !== p.name);
                    _savePresets(updated);
                    populatePresetSelect();
                    openPresetManager(); // 重新渲染列表
                });
                list.appendChild(row);
            });
        }

        modal.classList.add('open');

        const closeBtn = document.getElementById('tts-preset-close');
        if (closeBtn && !closeBtn._ttsBound) {
            closeBtn._ttsBound = true;
            closeBtn.addEventListener('click', () => {
                modal.classList.remove('open');
            });
        }
        if (!modal._ttsOverlayBound) {
            modal._ttsOverlayBound = true;
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.remove('open');
                }
            });
        }
    }

    /* ──────────────────────────────────────────────────────────────
       UI：TTS 全局配置区（加载 / 保存）
    ────────────────────────────────────────────────────────────── */

    function loadToUI() {
        const cfg = getConfig();
        _setVal('tts-global-switch',    cfg.globalEnabled    ?? false,   'checked');
        _setVal('tts-api-url-select',   cfg.apiUrl           || '');
        _setVal('tts-api-key',          cfg.apiKey           || '');
        _setVal('tts-group-id',         cfg.groupId          || '');
        _setVal('tts-model-select',     cfg.model            || 'speech-01-turbo');
        _setVal('tts-default-voice-id', cfg.defaultVoiceId   || 'male-qn-qingse');
        populatePresetSelect();
    }

    function saveFromUI() {
        const cfg = {
            ...(getConfig() || {}),
            globalEnabled:  !!_getVal('tts-global-switch',    'checked'),
            apiUrl:         _getVal('tts-api-url-select')     || '',
            apiKey:         _getVal('tts-api-key')            || '',
            groupId:        _getVal('tts-group-id')           || '',
            model:          _getVal('tts-model-select')       || 'speech-01-turbo',
            defaultVoiceId: _getVal('tts-default-voice-id')   || 'male-qn-qingse',
        };
        try { localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(cfg)); } catch (_) {}
        if (typeof db !== 'undefined') db.ttsSettings = cfg;
        if (typeof saveData === 'function') saveData();
    }

    /* ──────────────────────────────────────────────────────────────
       UI：角色语音标签页（加载 / 保存）—— 由 settings.js 调用
    ────────────────────────────────────────────────────────────── */

    /** 将角色对象的语音参数填入语音 Tab 表单 */
    function loadCharVoiceToUI(chat) {
        if (!chat) return;
        _setVal('setting-tts-enabled',   chat.ttsEnabled   ?? false,  'checked');
        _setVal('setting-tts-voice-id',  chat.ttsVoiceId   || '');
        // 语速拉杆
        const speedSlider = document.getElementById('setting-tts-speed');
        const speedLabel  = document.getElementById('setting-tts-speed-value');
        if (speedSlider) {
            speedSlider.value = chat.ttsSpeed !== undefined ? chat.ttsSpeed : 1.0;
            if (speedLabel) speedLabel.textContent = speedSlider.value;
        }
    }

    /** 从语音 Tab 表单读取并写回角色对象（返回修改后的字段，不调用 saveData） */
    function saveCharVoiceFromUI(chat) {
        if (!chat) return;
        chat.ttsEnabled = !!_getVal('setting-tts-enabled', 'checked');
        chat.ttsVoiceId = _getVal('setting-tts-voice-id') || '';
        chat.ttsSpeed   = parseFloat(document.getElementById('setting-tts-speed')?.value || '1.0');
    }

    /* ──────────────────────────────────────────────────────────────
       初始化 API 设置页面的 TTS 区块
    ────────────────────────────────────────────────────────────── */

    /** 即时将当前表单值写入 localStorage（不弹 toast，供 input/change 用） */
    function persistToLocalStorage() {
        const cfg = {
            ...(getConfig() || {}),
            globalEnabled:  !!_getVal('tts-global-switch',    'checked'),
            apiUrl:         _getVal('tts-api-url-select')     || '',
            apiKey:         _getVal('tts-api-key')            || '',
            groupId:        _getVal('tts-group-id')           || '',
            model:          _getVal('tts-model-select')       || 'speech-01-turbo',
            defaultVoiceId: _getVal('tts-default-voice-id')   || 'male-qn-qingse',
        };
        try { localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(cfg)); } catch (_) {}
    }

    function initApiSection() {
        loadToUI();
        _bind('tts-save-btn',        'click', () => { saveFromUI(); if (typeof showToast === 'function') showToast('TTS 设置已保存！'); });
        _bind('tts-test-btn',        'click', () => testTTS());
        _bind('tts-save-preset',     'click', () => savePreset());
        _bind('tts-apply-preset',    'click', () => applyPreset());
        _bind('tts-delete-preset',   'click', () => deleteCurrentPreset());
        // 所有 TTS 表单变更即时写入 localStorage，确保刷新不丢失
        const ids = ['tts-global-switch', 'tts-api-url-select', 'tts-api-key', 'tts-group-id', 'tts-model-select', 'tts-default-voice-id'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                const ev = el.type === 'checkbox' ? 'change' : 'input';
                el.addEventListener(ev, () => persistToLocalStorage());
            }
        });
    }

    /** 初始化角色语音 Tab 的拉杆实时显示 */
    function initCharVoiceTab() {
        _bindRange('setting-tts-speed', 'setting-tts-speed-value');
    }

    /* ──────────────────────────────────────────────────────────────
       DOM 工具
    ────────────────────────────────────────────────────────────── */

    function _setVal(id, value, prop) {
        const el = document.getElementById(id);
        if (!el) return;
        if (prop === 'checked') el.checked = !!value;
        else el.value = value;
    }

    function _getVal(id, prop) {
        const el = document.getElementById(id);
        if (!el) return prop === 'checked' ? false : '';
        return prop === 'checked' ? el.checked : el.value;
    }

    function _bind(id, event, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, handler);
    }

    function _bindRange(sliderId, labelId) {
        const slider = document.getElementById(sliderId);
        const label  = document.getElementById(labelId);
        if (slider && label) {
            slider.addEventListener('input', () => { label.textContent = slider.value; });
        }
    }

    /* ──────────────────────────────────────────────────────────────
       公开 API
    ────────────────────────────────────────────────────────────── */
    return {
        // 状态查询
        isGlobalEnabled,
        isCharEnabled,

        // iOS / Safari 音频通道预解锁
        unlockAppleAudio,

        // 语音气泡播放（Task 3）
        playVoiceBubble,
        stopCurrent,

        // 通话流式（Task 4）
        unlockCallAudio,
        resetCallStream,
        feedCallChunk,
        flushCallBuffer,
        cleanCallText,
        playCallAudioById,
        beginCallAiReplyTurn,
        takePendingVoiceTtsId,
        prefetchCallUserLineAudio,

        // TTS 内存缓存相关（供通话模块显式复用缓存逻辑）
        getFromTtsCache,
        getTtsCacheKey,
        ttsCache: state.ttsCache,

        // 测试（Task 1）
        testTTS,

        // 配置 UI（Task 1 & 2）
        initApiSection,
        initCharVoiceTab,
        loadToUI,
        saveFromUI,
        loadCharVoiceToUI,
        saveCharVoiceFromUI,

        // 预设（Task 1）
        populatePresetSelect,
        savePreset,
        applyPreset,
        deleteCurrentPreset,

        // 直接暴露 state 供调试（只读用途）
        _state: state,
    };

})();

window.TTSModule = TTSModule;
