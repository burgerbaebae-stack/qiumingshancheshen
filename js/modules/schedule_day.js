// --- 角色一日日程（私聊）：生成、版本、设置、注入对话 system ---

function scheduleDayLocalDateKey() {
    const d = new Date();
    const p = typeof pad === 'function' ? pad : (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地日期+时刻，生成/对话注入时用于区分「已过去」与「尚未发生」 */
function scheduleDayFormatLocalNow(d = new Date()) {
    const p = typeof pad === 'function' ? pad : (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function scheduleDayEnsureChar(char) {
    if (!char.schedule) {
        char.schedule = {
            dateKey: '',
            versions: [],
            activeVersionId: null,
            archive: [],
            settings: { worldBookIds: [], maxContextMessages: 20, includeFavoritedJournals: false }
        };
    }
    if (!char.schedule.settings) {
        char.schedule.settings = { worldBookIds: [], maxContextMessages: 20, includeFavoritedJournals: false };
    }
    if (!Array.isArray(char.schedule.versions)) char.schedule.versions = [];
    if (!Array.isArray(char.schedule.archive)) char.schedule.archive = [];
    if (!Array.isArray(char.schedule.settings.worldBookIds)) char.schedule.settings.worldBookIds = [];
}

/** 跨日时：把昨日「当前采用」整段归档，并清空当日版本。返回是否发生过写入（用于决定是否触发 saveData） */
function scheduleDayRollDateIfNeeded(char) {
    scheduleDayEnsureChar(char);
    const today = scheduleDayLocalDateKey();
    if (char.schedule.dateKey === today) return false;

    const prevKey = char.schedule.dateKey;
    const active = char.schedule.versions.find(v => v.id === char.schedule.activeVersionId);
    if (prevKey && active && (active.text || '').trim()) {
        char.schedule.archive.push({
            dateKey: prevKey,
            text: active.text.trim(),
            archivedAt: Date.now()
        });
    }
    char.schedule.dateKey = today;
    char.schedule.versions = [];
    char.schedule.activeVersionId = null;
    return true;
}

function scheduleDayWorldBookIdsForGen(char) {
    const ids = char.schedule.settings.worldBookIds;
    if (ids && ids.length) return ids;
    return char.worldBookIds || [];
}

function scheduleDayBuildWorldBooksText(char) {
    const ids = scheduleDayWorldBookIdsForGen(char);
    return ids
        .map(id => db.worldBooks.find(wb => wb.id === id))
        .filter(Boolean)
        .map(wb => `【${wb.name}】\n${wb.content}`)
        .join('\n\n---\n\n');
}

function scheduleDayBuildHistorySnippet(char) {
    const n = Math.max(0, parseInt(char.schedule.settings.maxContextMessages, 10) || 0);
    if (n === 0) return '';
    let slice = (char.history || []).slice(-n);
    if (typeof filterHistoryForAI === 'function') {
        slice = filterHistoryForAI(char, slice, false);
    }
    slice = slice.filter(m => !m.isThinking && !m.isContextDisabled);
    return slice.map(m => (m.content || '').trim()).filter(Boolean).join('\n');
}

function scheduleDayBuildFavoritedJournalsText(char) {
    if (!char.schedule.settings.includeFavoritedJournals) return '';
    const fav = (char.memoryJournals || []).filter(j => j.isFavorited);
    if (!fav.length) return '';
    return fav.map(j => `《${j.title}》\n${j.content}`).join('\n\n---\n\n');
}

function scheduleDayYesterdayArchiveHint(char) {
    const ar = char.schedule.archive || [];
    if (!ar.length) return '';
    const last = ar[ar.length - 1];
    return (last && last.text) ? last.text.trim() : '';
}

function scheduleDayBuildGenerationUserPrompt(char) {
    const wb = scheduleDayBuildWorldBooksText(char);
    const hist = scheduleDayBuildHistorySnippet(char);
    const fav = scheduleDayBuildFavoritedJournalsText(char);
    const yest = scheduleDayYesterdayArchiveHint(char);
    const today = scheduleDayLocalDateKey();
    const nowLine = scheduleDayFormatLocalNow();
    const personaChar = char.persona || '';
    const personaUser = char.myPersona || '';

    let parts = [];
    parts.push(
        `【模式 A · 纯便签】为角色「${char.realName || char.name}」填写**日历日 ${today}** 的**日程便签**（不是日记、不是小说段落、不写心理与对话）。\n` +
            `【对照时刻】用户本地此刻 **${nowLine}**。**此刻之后**的计划行用**尚未发生**语气，可省略主语，用短语（将/预计/若无干扰）；**禁止**写成已发生的细叙事。**此刻之前**若需交代：只允许 **1 行**「此刻前｜—｜已概：……」，「已概」不超过 **22 字**，不写过程。\n` +
            `【输出格式】除「此刻前」行外，每一计划行必须严格为三栏，用竖线分隔（**半角 | 或全角 ｜** 均可，每行恰好**两段**竖线即三栏），无其它 Markdown、无小标题：\n` +
            `时段或时段范围 | 地点或场景类型 | 一件主事（仅短语/动宾，**8～32 字**，禁止从句套从句）\n` +
            `示例（仅示意格式，勿照抄）：\n` +
            `17:30–19:00 | N109 仓库 | 验货与运输线问责\n` +
            `21:30前后 | 住处 | 与对方简短联络\n` +
            `**行数**：不设固定条数——今日事务多则多行，整日在家休整则 **1～2 行**即可，**禁止**为凑条数硬拆或硬编无关碎戏。\n` +
            `全文汉字（含竖线与标点）合计 **不超过 600 字**；与对方（${char.myName}）直接相关的计划行 **不宜超过 2 行或占总行数约 35%**（取更严者；整日无联络则可 0 行）。\n` +
            `【禁止】段落体；「他感到/心想/冷声/轻笑」等描写；引号对话；比喻与排比；单条内出现「并/因此/随后」串联多件以上的长句。`
    );
    parts.push(
        `\n【硬性要求】\n` +
            `1. 主干须来自：角色人设、作息与身份、下方勾选的世界书；是「自己的事务清单」，不是陪护流水账。\n` +
            `2. 与身份相关的计划里，若今日确有外出/事务，其中至少 **2 行**与对方（${char.myName}）**无直接因果**的地盘/工作/私事；若今日纯属居家休整，可合并表述，**不强求**凑满两条。\n` +
            `3. 若提供「最近聊天记录」：只许改 1～2 个主事措辞以衔接承诺/冷战等，**禁止**把大半行写成照护或甜宠剧情。\n` +
            `4. 若提供「昨日已采用日程」：避免同日重复同一类主线（可换地点、换待办名目）。\n` +
            `5. 时段与人设作息大致相容即可；**勿为凑字数虚构与身份无关的碎戏**。`
    );
    parts.push(`\n【角色人设】\n${personaChar || '（未填写）'}`);
    parts.push(`\n【对方人设（${char.myName}）】\n${personaUser || '（未填写）'}`);
    if (wb) parts.push(`\n【世界书（全文）】\n${wb}`);
    else parts.push(`\n【世界书】\n（未勾选或未绑定）`);
    if (yest) parts.push(`\n【昨日已采用日程（勿重复主线）】\n${yest}`);
    if (hist) parts.push(`\n【最近聊天记录摘录】\n${hist}`);
    if (fav) parts.push(`\n【已收藏日记】\n${fav}`);
    parts.push(`\n请**只输出**上述格式的便签正文行（不要前言、不要后记、不要解释规则）。`);
    return parts.join('');
}

async function scheduleDayCallGenerate(char) {
    let { url, key, model } = db.apiSettings;
    if (!url || !key || !model) throw new Error('请先在 API 应用中完成设置');
    if (url.endsWith('/')) url = url.slice(0, -1);
    const userContent = scheduleDayBuildGenerationUserPrompt(char);
    const requestBody = {
        model,
        messages: [
            { role: 'system', content: '你只输出日程便签：每行「时段|地点|主事」两竖线三栏；短短语、无叙事无心理无对话；对此刻之后的行用计划语气。不要任何前言后语或规则复述。' },
            { role: 'user', content: userContent }
        ],
        temperature: 0.55,
        // 便签体输出很短；压低 token 上限减轻网关与解析负担
        max_tokens: 1800
    };
    const endpoint = `${url}/v1/chat/completions`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    // 强制非流式：与聊天不同，日程一次 JSON 返回更稳；流式 + HTTP/2 在长连接上易出现 net::ERR_HTTP2_PROTOCOL_ERROR
    const raw = await fetchAiResponse(db.apiSettings, requestBody, headers, endpoint, { forceNonStream: true });
    return (raw || '').trim();
}

function scheduleDayAppendVersion(char, text, source) {
    scheduleDayEnsureChar(char);
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    char.schedule.versions.push({
        id,
        text: (text || '').trim(),
        createdAt: Date.now(),
        source: source === 'manual' ? 'manual' : 'ai'
    });
    char.schedule.activeVersionId = id;
    return id;
}

/** 供 chat_ai 注入：仅当日且有采用版本时返回段落 */
function getScheduleDayPromptBlock(character) {
    if (!character || !character.realName) return '';
    scheduleDayEnsureChar(character);
    const today = scheduleDayLocalDateKey();
    if (character.schedule.dateKey !== today) return '';
    const active = character.schedule.versions.find(v => v.id === character.schedule.activeVersionId);
    if (!active || !(active.text || '').trim()) return '';
    const body = active.text.trim();
    const nowLine = scheduleDayFormatLocalNow();
    return (
        `C. 【今日日程便签】以下为**本自然日**的短行计划（便签体，非日记叙事）；须与人设、世界书一致。\n` +
        `**用户本地此刻**：${nowLine}（与上文核心规则 **A「剧内时间 = 用户本地时间」** 为同一基准）。\n` +
        `**如何对照**：逐行看便签里的时段（含「此刻前」「HH:MM」等）。**该行计划开始时间晚于本地此刻** → 整行视为**尚未发生**，可见回复与内在状态**不得**描写该行已做完。**该行结束时间早于本地此刻** → 原则上已过（「此刻前」行仅概括、不写细叙事）。**本地此刻落在该行起止之间** → 视为**进行中**，处境只写与该段相容的内容，**不要**提前写到**更晚一行**的专属事项。\n` +
        `聊天若出现突发事件，允许暂时偏离便签；但仍须遵守 **A** 的钟点真实感，**禁止**用「快十点了」等编造与 ${nowLine} 矛盾的当下钟点。\n` +
        `**与内在状态**：把握节奏与可捡话题；**禁止**在可见消息中复述便签全文。\n\n` +
        `${body}\n\n`
    );
}
window.getScheduleDayPromptBlock = getScheduleDayPromptBlock;

let scheduleDayBoundCharId = null;

function scheduleDayGetChar() {
    if (currentChatType !== 'private' || !currentChatId) return null;
    return db.characters.find(c => c.id === currentChatId) || null;
}

function scheduleDayRenderVersions(char) {
    const ul = document.getElementById('schedule-day-versions-list');
    if (!ul) return;
    ul.innerHTML = '';
    const vs = [...(char.schedule.versions || [])].sort((a, b) => b.createdAt - a.createdAt);
    vs.forEach(v => {
        const li = document.createElement('li');
        li.className = 'schedule-day-version-item';
        const isActive = v.id === char.schedule.activeVersionId;
        const src = v.source === 'manual' ? '手动' : 'AI';
        const t = new Date(v.createdAt);
        const p = typeof pad === 'function' ? pad : (n) => String(n).padStart(2, '0');
        const timeStr = `${t.getHours()}:${p(t.getMinutes())}`;
        const meta = document.createElement('div');
        meta.className = 'schedule-day-version-meta';
        meta.innerHTML = `<span class="schedule-day-version-tag">${src}</span><span class="schedule-day-version-time">${timeStr}</span>` +
            (isActive ? '<span class="schedule-day-version-active">当前采用</span>' : '');
        const preview = document.createElement('div');
        preview.className = 'schedule-day-version-preview';
        const full = v.text || '';
        const head = full.length > 240 ? full.slice(0, 240) : full;
        const raw = head.replace(/\s+/g, ' ').trim();
        preview.textContent = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-small schedule-day-adopt-btn';
        btn.dataset.versionId = v.id;
        btn.textContent = '采用';
        li.appendChild(meta);
        li.appendChild(preview);
        li.appendChild(btn);
        ul.appendChild(li);
    });
    ul.querySelectorAll('.schedule-day-adopt-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.versionId;
            char.schedule.activeVersionId = id;
            const ver = char.schedule.versions.find(x => x.id === id);
            const ed = document.getElementById('schedule-day-editor');
            if (ed && ver) ed.value = ver.text || '';
            await saveData();
            scheduleDayRenderVersions(char);
            showToast('已切换为采用的日程版本');
        });
    });
}

/**
 * 与 openShopScreen 同序：轻量准备 → 立刻 switchScreen → 下一帧再填 UI。
 * 注意：打开时**不要**每次 saveData()——saveData 会 Dexie bulkPut 全库，主线程可达 ~1s（Performance 里 Scripting 大头）。
 * 仅跨日 roll 改动了内存数据时，再在空闲回调里延迟落库。
 */
function scheduleDayOpenScreen() {
    const char = scheduleDayGetChar();
    if (!char) {
        showToast('仅私聊可使用日程');
        return;
    }
    scheduleDayBoundCharId = char.id;
    const scheduleDirty = scheduleDayRollDateIfNeeded(char);

    const title = document.getElementById('schedule-day-title');
    if (title) title.textContent = `日程 · ${char.remarkName || char.name || ''}`;
    const label = document.getElementById('schedule-day-date-label');
    if (label) label.textContent = `今天这一页 · ${scheduleDayLocalDateKey()}`;

    if (typeof switchScreen === 'function') switchScreen('schedule-day-screen');

    const charRef = char;
    const wpLayer = document.getElementById('schedule-day-wallpaper-layer');
    if (wpLayer) {
        const u = (charRef.chatBg || '').trim();
        if (u) {
            wpLayer.style.backgroundImage = `linear-gradient(165deg, rgba(255,248,252,0.78) 0%, rgba(255,228,240,0.72) 48%, rgba(255,214,228,0.84) 100%), url(${u})`;
            wpLayer.style.backgroundSize = 'cover, cover';
            wpLayer.style.backgroundPosition = 'center, center';
        } else {
            wpLayer.style.backgroundImage = '';
            wpLayer.style.backgroundSize = '';
            wpLayer.style.backgroundPosition = '';
        }
    }

    requestAnimationFrame(() => {
        const active = charRef.schedule.versions.find(v => v.id === charRef.schedule.activeVersionId);
        const body = active ? (active.text || '') : '';
        scheduleDayRenderVersions(charRef);

        const ed = document.getElementById('schedule-day-editor');
        if (ed) {
            if (body.length > 8000) {
                ed.value = '';
                requestAnimationFrame(() => {
                    ed.value = body;
                });
            } else {
                ed.value = body;
            }
        }

        if (!scheduleDirty) return;

        const runSave = () => {
            saveData().catch((e) => {
                console.error(e);
                if (typeof showToast === 'function') showToast('日程状态保存失败，请稍后重试');
            });
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(runSave, { timeout: 4000 });
        } else {
            setTimeout(runSave, 0);
        }
    });
}

function scheduleDayCloseSettingsOverlay() {
    const ov = document.getElementById('schedule-day-settings-overlay');
    if (ov) ov.style.display = 'none';
}

function scheduleDayOpenSettings() {
    const char = db.characters.find(c => c.id === scheduleDayBoundCharId);
    if (!char) return;
    scheduleDayEnsureChar(char);
    const ov = document.getElementById('schedule-day-settings-overlay');
    const num = document.getElementById('schedule-day-max-msgs');
    const cj = document.getElementById('schedule-day-include-journals');
    if (num) num.value = String(char.schedule.settings.maxContextMessages ?? 20);
    if (cj) cj.checked = !!char.schedule.settings.includeFavoritedJournals;

    const list = document.getElementById('schedule-day-wb-list');
    if (list && typeof renderCategorizedWorldBookList === 'function') {
        renderCategorizedWorldBookList(list, db.worldBooks || [], char.schedule.settings.worldBookIds || [], 'sched-wb');
    }
    if (ov) ov.style.display = 'flex';
}

async function scheduleDaySaveSettings() {
    const char = db.characters.find(c => c.id === scheduleDayBoundCharId);
    if (!char) return;
    scheduleDayEnsureChar(char);
    const num = document.getElementById('schedule-day-max-msgs');
    const cj = document.getElementById('schedule-day-include-journals');
    let maxM = parseInt(num && num.value, 10);
    if (Number.isNaN(maxM) || maxM < 0) maxM = 20;
    if (maxM > 500) maxM = 500;
    char.schedule.settings.maxContextMessages = maxM;
    char.schedule.settings.includeFavoritedJournals = !!(cj && cj.checked);

    const selected = [];
    document.querySelectorAll('#schedule-day-wb-list .item-checkbox:checked').forEach(cb => {
        selected.push(cb.value);
    });
    char.schedule.settings.worldBookIds = selected;
    await saveData();
    showToast('日程设置已保存');
    scheduleDayCloseSettingsOverlay();
}

function scheduleDayInitUI() {
    const back = document.getElementById('schedule-day-back-btn');
    if (back) {
        back.addEventListener('click', () => {
            scheduleDayCloseSettingsOverlay();
            switchScreen('chat-room-screen');
        });
    }
    const setBtn = document.getElementById('schedule-day-settings-btn');
    if (setBtn) setBtn.addEventListener('click', () => scheduleDayOpenSettings());
    const setClose = document.getElementById('schedule-day-settings-close-btn');
    if (setClose) setClose.addEventListener('click', () => scheduleDayCloseSettingsOverlay());
    const setSave = document.getElementById('schedule-day-settings-save-btn');
    if (setSave) setSave.addEventListener('click', () => scheduleDaySaveSettings());

    const genBtn = document.getElementById('schedule-day-generate-btn');
    const regenBtn = document.getElementById('schedule-day-regenerate-btn');
    const manBtn = document.getElementById('schedule-day-save-manual-btn');

    async function runGen(isRegen) {
        const char = db.characters.find(c => c.id === scheduleDayBoundCharId);
        if (!char) return;
        scheduleDayEnsureChar(char);
        scheduleDayRollDateIfNeeded(char);
        if (!isRegen && char.schedule.versions.length > 0) {
            showToast('今日已有版本，请用「重新生成」或先采用空白后再生成');
            return;
        }
        showToast('正在生成日程…');
        try {
            const text = await scheduleDayCallGenerate(char);
            if (!text) throw new Error('返回为空');
            scheduleDayAppendVersion(char, text, 'ai');
            await saveData();
            const ed = document.getElementById('schedule-day-editor');
            if (ed) ed.value = text;
            scheduleDayRenderVersions(char);
            showToast('日程已生成');
        } catch (e) {
            console.error(e);
            const m = (e && e.message) || '';
            const netBroken =
                e.name === 'TypeError' ||
                /network|fetch failed|failed to fetch|http2|protocol_error|load failed/i.test(m);
            showToast(
                netBroken
                    ? '连接中断（常见于流式/HTTP2）。日程已改为非流式请求，请再试；仍失败请检查网络或中转线路。'
                    : m || '生成失败'
            );
        }
    }

    if (genBtn) genBtn.addEventListener('click', () => runGen(false));
    if (regenBtn) regenBtn.addEventListener('click', () => runGen(true));

    if (manBtn) {
        manBtn.addEventListener('click', async () => {
            const char = db.characters.find(c => c.id === scheduleDayBoundCharId);
            if (!char) return;
            const ed = document.getElementById('schedule-day-editor');
            const text = ed ? ed.value.trim() : '';
            if (!text) {
                showToast('内容为空');
                return;
            }
            scheduleDayAppendVersion(char, text, 'manual');
            await saveData();
            scheduleDayRenderVersions(char);
            showToast('已保存为手动新版本');
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleDayInitUI);
} else {
    scheduleDayInitUI();
}
