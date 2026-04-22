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

/** 便签编辑区：随内容增高，上限约 88vh；短内容不留大块空白 */
function scheduleDayFitEditorHeight() {
    const el = document.getElementById('schedule-day-editor');
    if (!el) return;
    const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 640;
    const maxPx = Math.min(vh * 0.88, 980);
    const minPx = 160;
    el.style.height = '';
    el.style.height = 'auto';
    const raw = el.scrollHeight;
    const target = Math.min(maxPx, Math.max(minPx, raw + 16));
    el.style.height = `${target}px`;
    el.style.overflowY = raw + 16 > maxPx ? 'auto' : 'hidden';
}
window.scheduleDayFitEditorHeight = scheduleDayFitEditorHeight;

function scheduleDayEnsureChar(char) {
    if (!char.schedule) {
        char.schedule = {
            dateKey: '',
            versions: [],
            activeVersionId: null,
            archive: [],
            pendingTrips: [],
            settings: { worldBookIds: [], maxContextMessages: 20, includeFavoritedJournals: false }
        };
    }
    if (!char.schedule.settings) {
        char.schedule.settings = { worldBookIds: [], maxContextMessages: 20, includeFavoritedJournals: false };
    }
    if (!Array.isArray(char.schedule.versions)) char.schedule.versions = [];
    if (!Array.isArray(char.schedule.archive)) char.schedule.archive = [];
    if (!Array.isArray(char.schedule.settings.worldBookIds)) char.schedule.settings.worldBookIds = [];
    if (!Array.isArray(char.schedule.pendingTrips)) char.schedule.pendingTrips = [];
}

function scheduleDayFormatMsgClock(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
    const d = new Date(ts);
    const p = typeof pad === 'function' ? pad : (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日程变更专用：最近 n 条带 [HH:mm] 与角色标签 */
function scheduleDayBuildHistorySnippetTimed(char) {
    const n = Math.max(0, parseInt(char.schedule.settings.maxContextMessages, 10) || 0);
    if (n === 0) return '';
    let slice = (char.history || []).slice(-n);
    if (typeof filterHistoryForAI === 'function') {
        slice = filterHistoryForAI(char, slice, false);
    }
    slice = slice.filter(m => !m.isThinking && !m.isContextDisabled);
    return slice
        .map((m) => {
            const raw = (m.content || '').trim();
            if (!raw) return '';
            const label = m.role === 'user' ? '对方' : '角色';
            const clock = scheduleDayFormatMsgClock(m.timestamp);
            const prefix = clock ? `[${clock}] ` : '';
            return `${prefix}${label}：${raw}`;
        })
        .filter(Boolean)
        .join('\n');
}

/** 待办行程：未写日期或日期 ≥ 今日 的条目，注入生成 */
function scheduleDayBuildPendingTripsBlock(char) {
    scheduleDayEnsureChar(char);
    const today = scheduleDayLocalDateKey();
    const list = (char.schedule.pendingTrips || []).filter((t) => {
        const d = ((t && t.targetDate) || '').trim();
        return !d || d >= today;
    });
    if (!list.length) return '';
    return list
        .map((t, i) => {
            const datePart = ((t && t.targetDate) || '').trim();
            const sum = ((t && t.summary) || '').trim() || '（无说明）';
            return `${i + 1}. ${datePart ? `【${datePart}】` : '【日期待定】'}${sum}`;
        })
        .join('\n');
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
    const pending = scheduleDayBuildPendingTripsBlock(char);
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
            `16:00前后 | 花店 | 订花并安排送达对方\n` +
            `**行数**：不设固定条数——今日事务多则多行，整日在家休整则 **1～2 行**即可，**禁止**为凑条数硬拆或硬编无关碎戏。**字数不设硬顶来卡行数**：宜保持便签体简洁，全文（含竖线与标点）**软上限约 1000 字**，事务极多时可略超，仍须每条简短、禁止叙事扩写。\n` +
            `与对方（${char.myName}）有关的 **具象事务**（见面、送礼、代办事、约定到访等）计划行 **不宜超过 2 行或占总行数约 35%**（取更严者；整日无此类事务则可 0 行）。\n` +
            `【禁止】段落体；「他感到/心想/冷声/轻笑」等描写；引号对话；比喻与排比；单条内出现「并/因此/随后」串联多件以上的长句。`
    );
    parts.push(
        `\n【硬性要求】\n` +
            `1. 主干须来自：角色人设、作息与身份、下方勾选的世界书；是「自己的事务清单」，不是陪护流水账。\n` +
            `2. 与身份相关的计划里，若今日确有外出/事务，其中至少 **2 行**与对方（${char.myName}）**无直接因果**的地盘/工作/私事；若今日纯属居家休整，可合并表述，**不强求**凑满两条。\n` +
            `3. 若提供「最近聊天记录」：只许改 1～2 个主事措辞以衔接承诺/冷战等，**禁止**把大半行写成照护或甜宠剧情。\n` +
            `4. 若提供「昨日已采用日程」：避免同日重复同一类主线（可换地点、换待办名目）。\n` +
            `5. 时段与人设作息大致相容即可；**勿为凑字数虚构与身份无关的碎戏**。\n` +
            `6. **日程粒度（重要）**：便签只写**线下/地盘/实体链条上**的具象事务（出行、工作块、训练、当面会面、**实物**送礼与快递、待办行程等），**不是**聊天或通话预告。**禁止**单独成行：视频/语音通话（即时可做，不占行程）、例行晚安或固定情话/仪式、**即时消息里就能完成的关心与叮嘱**（饮食作息、泛泛健康关切、空泛问安等）、无对应**外部动作**的联络。**允许**与对方有关的**外部行动**（同城订购送达、赴约见面、代办事、接送、当面交接）。统计「与对方有关的行数」时**只计上述外部行动**，其余不算、勿硬塞。\n` +
            `7. **内容丰富度（通用）**：宜**多样交错**，避免全天同一单调主线。**禁止**为凑多样而**机械地天天出差/天天航班**；跨城、飞行、异地据点仅在人设与世界书真有支撑、或**待办行程/昨日便签未重复**时再写，**本地常驻地事务仍是默认主轴**。**爱好、锻炼、社交壳、地盘私事**可穿插；与设定相容即可，勿扩写叙事。`
    );
    parts.push(`\n【角色人设】\n${personaChar || '（未填写）'}`);
    parts.push(`\n【对方人设（${char.myName}）】\n${personaUser || '（未填写）'}`);
    if (wb) parts.push(`\n【世界书（全文）】\n${wb}`);
    else parts.push(`\n【世界书】\n（未勾选或未绑定）`);
    if (yest) parts.push(`\n【昨日已采用日程（勿重复主线）】\n${yest}`);
    if (pending) {
        parts.push(
            `\n【待办行程（用户维护；须合理安排进便签。日期为今日或已过的须写进今日或「此刻前」已发生侧；未到日期的可写准备/出发类计划，勿编造已抵达）】\n${pending}`
        );
    }
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
            {
                role: 'system',
                content:
                    '你只输出日程便签：每行「时段|地点|主事」两竖线三栏；短短语、无叙事无心理无对话；对此刻之后的行用计划语气。禁止排视频/语音通话、例行晚安、即时消息即可完成的关心与问安占行；勿为凑多样而天天出差。不要前言后语或规则复述。'
            },
            { role: 'user', content: userContent }
        ],
        temperature: 0.45,
        // 便签可较长时略抬高上限，避免截断
        max_tokens: 2400
    };
    const endpoint = `${url}/v1/chat/completions`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    // 强制非流式：与聊天不同，日程一次 JSON 返回更稳；流式 + HTTP/2 在长连接上易出现 net::ERR_HTTP2_PROTOCOL_ERROR
    const raw = await fetchAiResponse(db.apiSettings, requestBody, headers, endpoint, { forceNonStream: true });
    return (raw || '').trim();
}

function scheduleDayBuildChangeUserPrompt(char, currentStickyText) {
    const wb = scheduleDayBuildWorldBooksText(char);
    const timedHist = scheduleDayBuildHistorySnippetTimed(char);
    const pending = scheduleDayBuildPendingTripsBlock(char);
    const fav = scheduleDayBuildFavoritedJournalsText(char);
    const yest = scheduleDayYesterdayArchiveHint(char);
    const today = scheduleDayLocalDateKey();
    const nowLine = scheduleDayFormatLocalNow();
    const personaChar = char.persona || '';
    const personaUser = char.myPersona || '';
    const sticky = (currentStickyText || '').trim();

    const parts = [];
    parts.push(
        `【模式 B · 日程变更】在**日历日 ${today}** 上**修订**全日程便签（不是日记）。输出格式与模式 A 相同：除「此刻前」行外每行「时段|地点|主事」两竖线三栏；短语体、无叙事无心理无对话。\n` +
            `【剧情切断锚点】用户本地时刻 **${nowLine}**。以此为界：\n` +
            `- **原则上已结束**（计划行结束时间早于该锚点，或属「此刻前」已概）→ **保留原意**，措辞可略理顺。\n` +
            `- **进行中且被剧情打断**（时段跨越该锚点、且下方对话显示活动已提前结束/改签）：将该行**截断到锚点之前**收束，主事可点明提前结束或转场；**禁止**仍写到原结束时刻却假装仍在进行。\n` +
            `- **锚点之后尚未发生**的计划行 → **全部作废并重排**，须与下方**带时间戳对话**、人设、世界书、待办行程一致；对话显示人已异地、交通已改的须体现，**禁止**与对话矛盾。\n` +
            `- 若无对话线索，勿编造剧烈冲突；可写与人设一致的合理后续事务。\n` +
            `【对照时刻】生成时用户本地仍为 **${nowLine}**；「此刻前」行规则、字数与模式 A 相同（已概不超过 22 字）。\n` +
            `全文篇幅与模式 A 相同（便签体、软上限约 1000 字）；与对方（${char.myName}）有关的 **具象事务** 行不宜超过 2 行或约 35%（取更严）。\n` +
            `【禁止】段落体、引号对话、心理描写、单条内多件长串。\n` +
            `【日程粒度】与模式 A 第 6 条一致：**禁止**视频/语音通话、例行晚安与仪式问候、即时联络即可完成的关心与问安等占行；**允许**实物送达、赴约、代办事、接送等外部行动。旧便签含此类无效行须**删除**。\n` +
            `【丰富度】与模式 A 第 7 条一致：多样但不机械；**禁止**无动因的天天出差；本地为主，跨城仅在有支撑或待办时合理出现。`
    );
    parts.push(`\n【当前便签全文】（须在此基础上修订，输出**完整新的一页**）\n${sticky || '（当前为空，请主要依据对话与人设生成今日便签）'}`);
    parts.push(`\n【最近对话（前缀 [HH:mm] 为消息发送的本地时刻；推断中断、赖床推迟、改签等时**优先采信**）】\n${timedHist || '（无）'}`);
    parts.push(`\n【角色人设】\n${personaChar || '（未填写）'}`);
    parts.push(`\n【对方人设（${char.myName}）】\n${personaUser || '（未填写）'}`);
    if (wb) parts.push(`\n【世界书（全文）】\n${wb}`);
    else parts.push(`\n【世界书】\n（未勾选或未绑定）`);
    if (yest) parts.push(`\n【昨日已采用日程（勿重复主线）】\n${yest}`);
    if (pending) parts.push(`\n【待办行程】\n${pending}`);
    if (fav) parts.push(`\n【已收藏日记】\n${fav}`);
    parts.push(`\n请**只输出**完整便签正文行（不要前言、不要后记、不要解释规则）。`);
    return parts.join('');
}

async function scheduleDayCallChangeGenerate(char, currentStickyText) {
    let { url, key, model } = db.apiSettings;
    if (!url || !key || !model) throw new Error('请先在 API 应用中完成设置');
    if (url.endsWith('/')) url = url.slice(0, -1);
    const userContent = scheduleDayBuildChangeUserPrompt(char, currentStickyText);
    const requestBody = {
        model,
        messages: [
            {
                role: 'system',
                content:
                    '你只输出日程便签：每行「时段|地点|主事」两竖线三栏。日程变更须输出全日完整便签。禁止视频/通话、晚安仪式、即时消息即可完成的关心占行；勿机械天天出差。无叙事无心理无对话。不要前言后语。'
            },
            { role: 'user', content: userContent }
        ],
        temperature: 0.45,
        max_tokens: 2400
    };
    const endpoint = `${url}/v1/chat/completions`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
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
            scheduleDayFitEditorHeight();
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
                    requestAnimationFrame(() => scheduleDayFitEditorHeight());
                });
            } else {
                ed.value = body;
                requestAnimationFrame(() => {
                    scheduleDayFitEditorHeight();
                    requestAnimationFrame(scheduleDayFitEditorHeight);
                });
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

function scheduleDayClosePendingOverlay() {
    const ov = document.getElementById('schedule-day-pending-overlay');
    if (ov) ov.style.display = 'none';
}

/** 待办日期：左侧为展示用占位/已选值，真实 value 在隐藏的原生 date 上 */
function scheduleDayPendingDateSyncDisplay() {
    const input = document.getElementById('schedule-day-pending-date');
    const disp = document.getElementById('schedule-day-pending-date-display');
    if (!disp) return;
    const v = input && input.value ? String(input.value).trim() : '';
    if (!v) {
        disp.textContent = 'yyyy/mm/日';
        disp.classList.add('is-placeholder');
        return;
    }
    disp.classList.remove('is-placeholder');
    const parts = v.split('-');
    if (parts.length === 3) {
        disp.textContent = `${parts[0]}/${parts[1]}/${parts[2]}`;
    } else {
        disp.textContent = v;
    }
}

function scheduleDayRenderPendingList(char) {
    const ul = document.getElementById('schedule-day-pending-list');
    if (!ul) return;
    ul.innerHTML = '';
    scheduleDayEnsureChar(char);
    const trips = char.schedule.pendingTrips;
    trips.forEach((t, idx) => {
        const li = document.createElement('li');
        li.className = 'schedule-day-pending-item';
        const meta = document.createElement('span');
        meta.className = 'schedule-day-pending-item-meta';
        meta.textContent = ((t && t.targetDate) || '').trim() || '日期待定';
        const text = document.createElement('span');
        text.className = 'schedule-day-pending-item-text';
        text.textContent = ((t && t.summary) || '').trim() || '（无说明）';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-small schedule-day-pending-del';
        del.textContent = '删除';
        del.dataset.idx = String(idx);
        li.appendChild(meta);
        li.appendChild(text);
        li.appendChild(del);
        ul.appendChild(li);
    });
    ul.querySelectorAll('.schedule-day-pending-del').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const i = parseInt(btn.dataset.idx, 10);
            if (Number.isNaN(i)) return;
            trips.splice(i, 1);
            await saveData();
            scheduleDayRenderPendingList(char);
            showToast('已删除');
        });
    });
}

function scheduleDayOpenPendingOverlay() {
    const char = db.characters.find((c) => c.id === scheduleDayBoundCharId);
    if (!char) return;
    scheduleDayEnsureChar(char);
    scheduleDayCloseSettingsOverlay();
    const ov = document.getElementById('schedule-day-pending-overlay');
    scheduleDayRenderPendingList(char);
    const dateIn = document.getElementById('schedule-day-pending-date');
    const sumIn = document.getElementById('schedule-day-pending-summary');
    if (dateIn) dateIn.value = '';
    if (sumIn) sumIn.value = '';
    scheduleDayPendingDateSyncDisplay();
    if (ov) ov.style.display = 'flex';
}

function scheduleDayOpenSettings() {
    const char = db.characters.find(c => c.id === scheduleDayBoundCharId);
    if (!char) return;
    scheduleDayEnsureChar(char);
    scheduleDayClosePendingOverlay();
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
            scheduleDayClosePendingOverlay();
            switchScreen('chat-room-screen');
        });
    }
    const pendingBtn = document.getElementById('schedule-day-pending-btn');
    if (pendingBtn) pendingBtn.addEventListener('click', () => scheduleDayOpenPendingOverlay());
    const pendingClose = document.getElementById('schedule-day-pending-close-btn');
    if (pendingClose) pendingClose.addEventListener('click', () => scheduleDayClosePendingOverlay());
    const pendingOv = document.getElementById('schedule-day-pending-overlay');
    if (pendingOv) {
        pendingOv.addEventListener('click', (e) => {
            if (e.target === pendingOv) scheduleDayClosePendingOverlay();
        });
    }
    const pendingAddBtn = document.getElementById('schedule-day-pending-add-btn');
    if (pendingAddBtn) {
        pendingAddBtn.addEventListener('click', async () => {
            const char = db.characters.find((c) => c.id === scheduleDayBoundCharId);
            if (!char) return;
            scheduleDayEnsureChar(char);
            const dateIn = document.getElementById('schedule-day-pending-date');
            const sumIn = document.getElementById('schedule-day-pending-summary');
            const targetDate = dateIn && dateIn.value ? dateIn.value.trim() : '';
            const summary = sumIn ? sumIn.value.trim() : '';
            if (!summary) {
                showToast('请填写事由');
                return;
            }
            char.schedule.pendingTrips.push({
                id: `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                targetDate,
                summary,
                createdAt: Date.now()
            });
            await saveData();
            if (dateIn) dateIn.value = '';
            if (sumIn) sumIn.value = '';
            scheduleDayPendingDateSyncDisplay();
            scheduleDayRenderPendingList(char);
            showToast('已添加');
        });
    }
    const dateNative = document.getElementById('schedule-day-pending-date');
    if (dateNative) {
        dateNative.addEventListener('change', scheduleDayPendingDateSyncDisplay);
        dateNative.addEventListener('input', scheduleDayPendingDateSyncDisplay);
    }
    const setBtn = document.getElementById('schedule-day-settings-btn');
    if (setBtn) setBtn.addEventListener('click', () => scheduleDayOpenSettings());
    const setClose = document.getElementById('schedule-day-settings-close-btn');
    if (setClose) setClose.addEventListener('click', () => scheduleDayCloseSettingsOverlay());
    const setSave = document.getElementById('schedule-day-settings-save-btn');
    if (setSave) setSave.addEventListener('click', () => scheduleDaySaveSettings());

    const genBtn = document.getElementById('schedule-day-generate-btn');
    const regenBtn = document.getElementById('schedule-day-regenerate-btn');
    const changeBtn = document.getElementById('schedule-day-change-btn');
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
            requestAnimationFrame(() => {
                scheduleDayFitEditorHeight();
                requestAnimationFrame(scheduleDayFitEditorHeight);
            });
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

    async function runScheduleChange() {
        const char = db.characters.find((c) => c.id === scheduleDayBoundCharId);
        if (!char) return;
        scheduleDayEnsureChar(char);
        scheduleDayRollDateIfNeeded(char);
        const ed = document.getElementById('schedule-day-editor');
        let sticky = ed ? ed.value.trim() : '';
        if (!sticky) {
            const active = char.schedule.versions.find((v) => v.id === char.schedule.activeVersionId);
            if (active) sticky = (active.text || '').trim();
        }
        const timed = scheduleDayBuildHistorySnippetTimed(char);
        if (!sticky && !timed) {
            showToast('请先填写便签或确保有聊天记录可参考');
            return;
        }
        const msg =
            '将结合当前便签与带时间的最近对话，从本地「现在」起修订未发生段，必要时截断进行中的行。确定执行？';
        if (typeof confirm === 'function' && !confirm(msg)) return;
        showToast('正在日程变更…');
        try {
            const text = await scheduleDayCallChangeGenerate(char, sticky);
            if (!text) throw new Error('返回为空');
            scheduleDayAppendVersion(char, text, 'ai');
            await saveData();
            if (ed) ed.value = text;
            scheduleDayRenderVersions(char);
            requestAnimationFrame(() => {
                scheduleDayFitEditorHeight();
                requestAnimationFrame(scheduleDayFitEditorHeight);
            });
            showToast('日程变更完成');
        } catch (e) {
            console.error(e);
            const m = (e && e.message) || '';
            const netBroken =
                e.name === 'TypeError' ||
                /network|fetch failed|failed to fetch|http2|protocol_error|load failed/i.test(m);
            showToast(
                netBroken
                    ? '连接中断，请检查网络或稍后再试。'
                    : m || '日程变更失败'
            );
        }
    }

    if (changeBtn) changeBtn.addEventListener('click', () => runScheduleChange());

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
            scheduleDayFitEditorHeight();
            showToast('已保存为手动新版本');
        });
    }

    const edGlobal = document.getElementById('schedule-day-editor');
    if (edGlobal) {
        edGlobal.addEventListener('input', () => scheduleDayFitEditorHeight());
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleDayInitUI);
} else {
    scheduleDayInitUI();
}
