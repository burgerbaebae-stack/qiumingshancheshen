// --- 回忆日记功能 (js/modules/journal.js) ---
// 手账本风格 · 年/月/日 三层降维导航
// 数据结构零改动，全部逻辑在 renderJournalList() 中做分组展示

// ─── 模块状态 ───
// 与全局 isGenerating（聊天 AI 回复）分离，避免日记生成时无法发消息、也无法并行请求
let isJournalGenerating = false;
let generatingChatId    = null;

// 生成结果顶栏：null | { kind, chatId, chatType, successNav? }
// successNav：成功时点 ✓ 跳转日视图并打开抽屉 { jYear, jMonth, day }（与 _groupByDate 键一致）
let journalGenerateOutcomeBanner = null;
// 上次「生成日记」表单参数（仅用于失败重试预填；须与当前会话匹配）
let lastJournalGenerateParams    = null;

// 层级导航（仅影响显示，不影响数据）
let jView  = 'year';  // 'year' | 'month' | 'day'
let jYear  = null;    // e.g. '2025'
let jMonth = null;    // e.g. '12'
/** 最近一次打开的「某日」底部抽屉对应的日（字符串，与 polaroid dataset.day 一致）；用于合并后/详情返回恢复抽屉 */
let jLastOpenedSheetDay = null;
/** 进入日记详情时，若从某日抽屉点入，则记下该日以便返回时重新打开抽屉 */
let jDetailFromSheetDay = null;

// 管理模式
let jManageMode = false;
let jSelectedIds = new Set();
/** 进入「合并/多选」前记下年/月/日导航，退出时还原（不强制回年份） */
let jManageReturnSnapshot = null;

// ─── 常量 ───
const J_MONTH_CN   = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
const J_MONTH_SHORT = ['一','二','三','四','五','六','七','八','九','十','十一','十二'];
const NOTE_ROTS = [1.2, -1.5, 0.8, -2.0, 1.6, -0.9, 2.1, -1.3, 0.7, -1.8, 1.4, -0.6];
const POL_ROTS  = [1.5,-1.2, 2.0,-0.8, 1.8,-2.1, 0.6,-1.7, 1.3,-0.9, 2.2,-1.4,
                   0.7,-1.1, 1.9,-0.5, 1.6,-1.8, 0.8,-2.0, 1.1,-0.7, 1.7,-1.5,
                   2.0,-0.6, 1.4,-1.9, 0.9,-1.3, 2.1];

// ─── 工具：获取当前聊天对象 ───
function _jChat() {
    return (currentChatType === 'private')
        ? db.characters.find(c => c.id === currentChatId)
        : db.groups.find(g => g.id === currentChatId);
}

// ─── 工具：按年/月/日分组 ───
function _groupByDate(journals) {
    const g = {};
    journals.forEach(j => {
        const d = new Date(j.createdAt);
        const y = String(d.getFullYear());
        const m = String(d.getMonth() + 1);
        const day = String(d.getDate());
        if (!g[y])       g[y] = {};
        if (!g[y][m])    g[y][m] = {};
        if (!g[y][m][day]) g[y][m][day] = [];
        g[y][m][day].push(j);
    });
    return g;
}

function _countYear(yd) {
    return Object.values(yd).reduce((s, md) =>
        s + Object.values(md).reduce((t, a) => t + a.length, 0), 0);
}
function _countMonth(md) {
    return Object.values(md).reduce((s, a) => s + a.length, 0);
}

function _journalOutcomeBannerApplies() {
    const b = journalGenerateOutcomeBanner;
    return !!(b && b.chatId === currentChatId && b.chatType === currentChatType);
}

/** 打开生成日记弹窗；prefill 仅在与当前会话一致时使用 */
function openGenerateJournalModal(opts = {}) {
    const prefill = opts.prefill;
    const modal   = document.getElementById('generate-journal-modal');
    const form    = document.getElementById('generate-journal-form');
    if (!modal || !form) return;

    const chat  = _jChat();
    const total = chat ? chat.history.length : 0;
    const info  = document.getElementById('journal-range-info');
    if (info) info.textContent = `当前聊天总消息数: ${total}`;

    const h3 = document.querySelector('#generate-journal-modal h3');
    if (h3) h3.textContent = (currentChatType === 'group') ? '生成群聊总结' : '指定总结范围';

    if (prefill && prefill.chatId === currentChatId && prefill.chatType === currentChatType) {
        document.getElementById('journal-range-start').value = prefill.start;
        document.getElementById('journal-range-end').value   = prefill.end;
        document.getElementById('journal-include-favorited').checked = !!prefill.includeFavorited;
    } else {
        form.reset();
    }

    modal.classList.add('visible');
}

// ─── 构建：年份视图 ───
function _buildYearView(grouped) {
    const years = Object.keys(grouped).sort((a, b) => b - a);
    const title = (currentChatType === 'group') ? '智能总结' : '回忆日记';
    const div = document.createElement('div');
    div.className = 'journal-year-view journal-layer-enter';
    div.innerHTML = `
        <div class="journal-cover-card">
            <div class="journal-cover-title">${title}</div>
            <div class="journal-cover-sub">Memory Diary</div>
        </div>
        <div class="journal-year-tabs-list">
            ${years.map(year => `
            <div class="journal-year-tab" data-year="${year}">
                <span class="journal-year-tab-year">${year}</span>
                <span class="journal-year-tab-count">${_countYear(grouped[year])} 篇</span>
                <span class="journal-year-tab-arrow">›</span>
            </div>`).join('')}
        </div>`;
    return div;
}

// ─── 构建：月份视图（便利贴） ───
function _buildMonthView(yearData) {
    const months = Object.keys(yearData).sort((a, b) => a - b);
    const div = document.createElement('div');
    div.className = 'journal-month-view journal-layer-enter';
    div.innerHTML = `
        <div class="journal-breadcrumb">
            <button class="journal-nav-back" data-action="back-year">← 年份</button>
            <span class="journal-breadcrumb-title">${jYear} 年</span>
        </div>
        <div class="journal-sticky-grid">
            ${months.map(m => {
                const idx = parseInt(m) - 1;
                const dayCount   = Object.keys(yearData[m]).length;
                const entryCount = _countMonth(yearData[m]);
                const rot = NOTE_ROTS[idx] ?? 0;
                return `
                <div class="journal-month-note note-color-${idx % 12}"
                     data-month="${m}" style="--rot: ${rot}deg">
                    <div class="month-note-top">
                        <span class="month-num">${String(parseInt(m)).padStart(2,'0')}</span>
                        <span class="month-cn">月</span>
                    </div>
                    <div class="month-note-stats">
                        <span class="stat-days">📅 ${dayCount} 天</span>
                        <span class="stat-entries">✍️ ${entryCount} 篇</span>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
    return div;
}

// ─── 构建：日期视图（拍立得） ───
function _buildDayView(monthData) {
    const days = Object.keys(monthData).sort((a, b) => a - b);
    const ms = J_MONTH_SHORT[parseInt(jMonth) - 1];
    const div = document.createElement('div');
    div.className = 'journal-day-view journal-layer-enter';
    div.innerHTML = `
        <div class="journal-breadcrumb">
            <button class="journal-nav-back" data-action="back-month">← 月份</button>
            <span class="journal-breadcrumb-title">${jYear} 年 ${ms} 月</span>
        </div>
        <div class="journal-polaroid-grid">
            ${days.map((day, idx) => {
                const cnt = monthData[day].length;
                const rot = POL_ROTS[idx % POL_ROTS.length];
                return `
                <div class="journal-day-polaroid" data-day="${day}"
                     style="--pol-rot: ${rot}deg">
                    <div class="polaroid-brad"></div>
                    <div class="polaroid-photo-area">
                        <div class="polaroid-date-num">${pad(parseInt(day))}</div>
                        <div class="polaroid-month-label">${ms}月</div>
                    </div>
                    <div class="polaroid-caption"><span class="pol-cnt">${cnt}</span> 篇</div>
                </div>`;
            }).join('')}
        </div>`;
    return div;
}

// ─── 构建：管理模式平铺列表 ───
function _buildManageList(journals) {
    const sorted = [...journals].sort((a, b) => b.createdAt - a.createdAt);
    const div = document.createElement('div');
    div.className = 'journal-manage-list';
    div.innerHTML = sorted.map(j => {
        const d = new Date(j.createdAt);
        const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        const sel = jSelectedIds.has(j.id);
        return `
        <div class="journal-manage-card${sel ? ' selected' : ''}" data-id="${j.id}">
            <div class="journal-manage-checkbox">${sel ? '✓' : ''}</div>
            <div class="journal-manage-card-info">
                <div class="journal-manage-card-title">${j.title}</div>
                <div class="journal-manage-card-date">${date} · 范围 ${j.range.start}–${j.range.end}</div>
            </div>
        </div>`;
    }).join('');
    return div;
}

// ─── 底部抽屉：打开 ───
function _openSheet(day) {
    jLastOpenedSheetDay = String(day);
    const ms = J_MONTH_SHORT[parseInt(jMonth) - 1];
    document.getElementById('journal-entry-sheet-date').textContent =
        `${jYear} 年 ${ms} 月 ${parseInt(day)} 日`;

    const chat = _jChat();
    const all  = chat ? (chat.memoryJournals || []) : [];
    const entries = all.filter(j => {
        const d = new Date(j.createdAt);
        return String(d.getFullYear())   === String(jYear)  &&
               String(d.getMonth() + 1)  === String(jMonth) &&
               String(d.getDate())        === String(day);
    }).sort((a, b) => a.createdAt - b.createdAt);

    const listEl = document.getElementById('journal-entry-list');
    if (entries.length === 0) {
        listEl.innerHTML = '<p style="text-align:center;color:#aaa;padding:20px;font-family:Georgia,serif;">暂无记录</p>';
    } else {
        listEl.innerHTML = entries.map(j => {
            const preview = j.content
                ? (j.content.length > 80 ? j.content.slice(0, 80) + '…' : j.content)
                : '';
            return `
            <div class="journal-entry-card" data-id="${j.id}">
                <div class="entry-card-header">
                    <div class="entry-card-title">${j.title}</div>
                    <div class="entry-card-actions">
                        <button class="entry-action-btn favorite-journal-btn${j.isFavorited ? ' favorited' : ''}" title="${j.isFavorited ? '取消收藏' : '收藏'}">
                            <svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                        </button>
                        <button class="entry-action-btn delete-journal-btn" title="删除">
                            <svg viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
                        </button>
                    </div>
                </div>
                <div class="entry-card-preview">${preview}</div>
                <div class="entry-card-footer">
                    <span class="entry-card-range">消息 ${j.range.start}–${j.range.end}</span>
                    ${j.isFavorited ? '<span class="entry-card-tag">已收藏</span>' : ''}
                </div>
            </div>`;
        }).join('');
    }

    document.getElementById('journal-entry-sheet').classList.add('open');
    document.getElementById('journal-sheet-overlay').classList.add('visible');
}

// ─── 底部抽屉：关闭 ───
function _closeSheet() {
    document.getElementById('journal-entry-sheet').classList.remove('open');
    document.getElementById('journal-sheet-overlay').classList.remove('visible');
}

function _captureJournalNavForManage() {
    jManageReturnSnapshot = {
        jView: jView,
        jYear: jYear,
        jMonth: jMonth,
        jLastOpenedSheetDay: jLastOpenedSheetDay
    };
}

function _restoreJournalNavAfterManage() {
    if (!jManageReturnSnapshot) return;
    jView = jManageReturnSnapshot.jView;
    jYear = jManageReturnSnapshot.jYear;
    jMonth = jManageReturnSnapshot.jMonth;
    jLastOpenedSheetDay = jManageReturnSnapshot.jLastOpenedSheetDay;
    jManageReturnSnapshot = null;
}

function _syncJournalManageChrome(managing) {
    const manageBtnEl = document.getElementById('journal-manage-btn');
    const multiBarEl    = document.getElementById('journal-multi-select-bar');
    const genBtn        = document.getElementById('generate-new-journal-btn');
    const bwb           = document.getElementById('bind-journal-worldbook-btn');
    if (managing) {
        if (manageBtnEl) manageBtnEl.style.display = 'none';
        if (multiBarEl) multiBarEl.style.display = 'flex';
        if (genBtn) genBtn.style.display = 'none';
        if (bwb) bwb.style.display = 'none';
    } else {
        if (manageBtnEl) manageBtnEl.style.display = 'flex';
        if (multiBarEl) multiBarEl.style.display = 'none';
        if (genBtn) genBtn.style.display = 'flex';
        if (bwb && currentChatType === 'private') bwb.style.display = 'flex';
    }
}

function _updateJournalSelectCountBadge() {
    const el = document.getElementById('journal-select-count');
    if (el) el.textContent = `已选 ${jSelectedIds.size} 篇`;
}

/** 退出多选/合并模式并回到进入前的日记层级（年/月/日） */
function exitJournalManageMode() {
    _restoreJournalNavAfterManage();
    jManageMode = false;
    jSelectedIds.clear();
    _syncJournalManageChrome(false);
    _updateJournalSelectCountBadge();
    renderJournalList();
}

// ─── 打开详情页 ───
function _openDetail(journal) {
    jDetailFromSheetDay = jLastOpenedSheetDay;
    const d = new Date(journal.createdAt);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    currentJournalDetailId = journal.id;

    const titleEl   = document.getElementById('journal-detail-title');
    const contentEl = document.getElementById('journal-detail-content');
    const editBtn   = document.getElementById('edit-journal-detail-btn');

    titleEl.removeAttribute('contenteditable');
    contentEl.removeAttribute('contenteditable');
    titleEl.style.border = 'none';
    contentEl.style.border = 'none';
    titleEl.style.outline = 'none';
    contentEl.style.outline = 'none';
    titleEl.style.outlineOffset = '';
    contentEl.style.outlineOffset = '';
    titleEl.style.padding = '';
    contentEl.style.padding = '';
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.13,5.12L18.88,8.87M3,17.25V21H6.75L17.81,9.94L14.06,6.19L3,17.25Z"/></svg>`;

    titleEl.textContent   = journal.title;
    document.getElementById('journal-detail-meta').textContent =
        `创建于 ${dateStr} | 消息范围: ${journal.range.start}-${journal.range.end}`;
    contentEl.textContent = journal.content;

    switchScreen('memory-journal-detail-screen');
}

// ─── 主渲染函数 ───
function renderJournalList() {
    const container   = document.getElementById('journal-list-container');
    const placeholder = document.getElementById('no-journals-placeholder');

    container.innerHTML = '';

    const chat    = _jChat();
    const journals = chat ? (chat.memoryJournals || []) : [];

    // 更新标题和按钮
    const bindBtn = document.getElementById('bind-journal-worldbook-btn');
    const titleEl = document.querySelector('#memory-journal-screen .title');
    if (currentChatType === 'group') {
        if (bindBtn)  bindBtn.style.display = 'none';
        if (titleEl)  titleEl.textContent   = '智能总结';
    } else {
        if (bindBtn && !jManageMode) bindBtn.style.display = 'flex';
        if (titleEl)  titleEl.textContent   = '回忆日记';
    }

    const genLoadingVisible = isJournalGenerating && generatingChatId === currentChatId;
    const outcomeVisible    = _journalOutcomeBannerApplies();
    const hasTopStatus      = genLoadingVisible || outcomeVisible;

    // 空状态（若有顶栏：生成中 / 成功提示 / 失败提示，则不显示全屏空状态）
    if ((!journals || journals.length === 0) && !hasTopStatus) {
        if (placeholder) placeholder.style.display = 'block';
        return;
    }
    if (placeholder) placeholder.style.display = 'none';

    // 顶栏：生成结果 或 生成中
    if (outcomeVisible) {
        const kind = journalGenerateOutcomeBanner.kind;
        const card = document.createElement('div');
        card.className = 'journal-generating-card journal-banner-' + (kind === 'success' ? 'success' : 'error');
        card.id = 'journal-generating-card';
        if (kind === 'success') {
            const msg = currentChatType === 'group' ? '新总结已生成~' : '新日记已生成~';
            card.innerHTML = `
                <div class="journal-banner-row">
                    <button type="button" class="journal-banner-dismiss journal-banner-ok" aria-label="打开该日日记列表" title="打开该日日记列表">
                        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                    </button>
                    <div class="journal-banner-textcol">
                        <div class="text">${msg}</div>
                        <p class="journal-banner-hint">点左侧 ✓ 打开该日日记列表</p>
                    </div>
                </div>`;
        } else {
            const errMsg = currentChatType === 'group' ? '群聊总结生成失败…' : '日记生成失败…';
            card.innerHTML = `
                <div class="journal-banner-row journal-banner-row-error">
                    <button type="button" class="journal-banner-retry" title="重新选择范围并生成">重新生成</button>
                    <div class="journal-banner-textcol">
                        <div class="text">${errMsg}</div>
                        <p class="journal-banner-hint">将打开生成窗口，可沿用或修改上次的范围与选项</p>
                    </div>
                </div>`;
        }
        container.appendChild(card);
    } else if (genLoadingVisible) {
        const el = document.createElement('div');
        el.className = 'journal-generating-card';
        el.id = 'journal-generating-card';
        el.innerHTML = `<div class="spinner"></div><div class="text">正在${currentChatType === 'group' ? '总结群聊' : '编织回忆'}...</div>`;
        container.appendChild(el);
    }

    // 管理模式：平铺全部日记
    if (jManageMode) {
        container.appendChild(_buildManageList(journals));
        return;
    }

    // 正常模式：层级导航
    const grouped = _groupByDate(journals);

    if (jView === 'year') {
        container.appendChild(_buildYearView(grouped));

    } else if (jView === 'month') {
        const yd = grouped[jYear];
        if (!yd) { jView = 'year'; container.appendChild(_buildYearView(grouped)); }
        else      container.appendChild(_buildMonthView(yd));

    } else if (jView === 'day') {
        const md = grouped[jYear]?.[jMonth];
        if (!md) { jView = 'month'; container.appendChild(_buildMonthView(grouped[jYear] || {})); }
        else      container.appendChild(_buildDayView(md));
    }
}

// ─── 初始化事件绑定 ───
function setupMemoryJournalScreen() {
    const generateNewJournalBtn     = document.getElementById('generate-new-journal-btn');
    const generateJournalModal      = document.getElementById('generate-journal-modal');
    const generateJournalForm       = document.getElementById('generate-journal-form');
    const editDetailBtn             = document.getElementById('edit-journal-detail-btn');
    const bindWorldBookBtn          = document.getElementById('bind-journal-worldbook-btn');
    const journalStyleModal         = document.getElementById('journal-style-selection-modal');
    const saveJournalStyleBtn       = document.getElementById('save-journal-style-btn');
    const journalStyleRadios        = document.querySelectorAll('input[name="journal-style-mode"]');
    const customStyleContainer      = document.getElementById('journal-custom-style-container');
    const journalStyleWorldBookList = document.getElementById('journal-style-worldbook-list');
    const manageBtn                 = document.getElementById('journal-manage-btn');
    const batchDeleteBtn            = document.getElementById('journal-batch-delete-btn');
    const mergeBtn                  = document.getElementById('journal-merge-btn');
    const journalListContainer      = document.getElementById('journal-list-container');
    const entryList                 = document.getElementById('journal-entry-list');
    const sheetCloseBtn             = document.getElementById('journal-entry-sheet-close');
    const sheetOverlay              = document.getElementById('journal-sheet-overlay');

    // ── 管理模式切换（退出时还原进入前的年/月/日，不强制回年份） ──
    function _toggleManage(active) {
        if (!active) {
            exitJournalManageMode();
            return;
        }
        _captureJournalNavForManage();
        jManageMode = true;
        jSelectedIds.clear();
        _updateJournalSelectCountBadge();
        _syncJournalManageChrome(true);
        _closeSheet();
        renderJournalList();
    }

    function _updateCount() {
        _updateJournalSelectCountBadge();
    }

    if (manageBtn) manageBtn.addEventListener('click', () => _toggleManage(true));

    // 合并/多选模式下拦截左上角返回：须早于 main.js 里 body 上对 .back-btn 的全局处理（否则会进聊天室）
    document.addEventListener('click', (e) => {
        if (!jManageMode) return;
        const back = e.target.closest && e.target.closest('#memory-journal-screen .app-header .back-btn');
        if (!back) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        exitJournalManageMode();
    }, true);

    // ── 批量删除 ──
    if (batchDeleteBtn) {
        batchDeleteBtn.addEventListener('click', async () => {
            if (jSelectedIds.size === 0) return;
            if (!confirm(`确定要删除选中的 ${jSelectedIds.size} 篇日记吗？此操作不可恢复。`)) return;
            const chat = _jChat();
            if (!chat) return;
            chat.memoryJournals = chat.memoryJournals.filter(j => !jSelectedIds.has(j.id));
            await saveData();
            _toggleManage(false);
            showToast('已批量删除');
        });
    }

    // ── 合并为一篇（机械拼接，不调 API） ──
    if (mergeBtn) {
        mergeBtn.addEventListener('click', async () => {
            if (jSelectedIds.size < 2) { showToast('请至少选择 2 篇日记进行合并'); return; }
            await mergeJournals(Array.from(jSelectedIds));
        });
    }

    // ── 绑定世界书 / 风格设置 ──
    bindWorldBookBtn.addEventListener('click', () => {
        const chat = _jChat();
        if (!chat) return;
        if (currentChatType === 'private') {
            const msg = migrateJournalSettings(chat);
            if (msg) showToast(msg);
            const mode  = chat.journalStyleSettings.mode || 'default';
            const radio = document.querySelector(`input[name="journal-style-mode"][value="${mode}"]`);
            if (radio) radio.checked = true;
            customStyleContainer.style.display = (mode === 'custom') ? 'flex' : 'none';
            renderCategorizedWorldBookList(journalStyleWorldBookList, db.worldBooks, chat.journalStyleSettings.customWorldBookIds || [], 'journal-style-wb-select');
            journalStyleModal.classList.add('visible');
        } else {
            showToast('群聊暂不支持自定义风格设置');
        }
    });

    journalStyleRadios.forEach(r => {
        r.addEventListener('change', e => {
            customStyleContainer.style.display = (e.target.value === 'custom') ? 'flex' : 'none';
        });
    });

    saveJournalStyleBtn.addEventListener('click', async () => {
        const chat = (currentChatType === 'private') ? _jChat() : null;
        if (!chat) return;
        const mode = document.querySelector('input[name="journal-style-mode"]:checked').value;
        const ids  = Array.from(journalStyleWorldBookList.querySelectorAll('.item-checkbox:checked')).map(i => i.value);
        chat.journalStyleSettings = { mode, customWorldBookIds: ids };
        chat.journalWorldBookIds  = ids;
        await saveData();
        journalStyleModal.classList.remove('visible');
        showToast('日记风格设置已保存');
    });

    // ── 生成新日记 ──
    generateNewJournalBtn.addEventListener('click', () => openGenerateJournalModal({}));

    generateJournalForm.addEventListener('submit', async e => {
        e.preventDefault();
        const start            = parseInt(document.getElementById('journal-range-start').value);
        const end              = parseInt(document.getElementById('journal-range-end').value);
        const includeFavorited = document.getElementById('journal-include-favorited').checked;
        if (isNaN(start) || isNaN(end) || start <= 0 || end < start) { showToast('请输入有效的起止范围'); return; }
        lastJournalGenerateParams = {
            chatId: currentChatId,
            chatType: currentChatType,
            start,
            end,
            includeFavorited
        };
        generateJournalModal.classList.remove('visible');
        await generateJournal(start, end, includeFavorited);
    });

    const journalDeleteRangeImagesBtn = document.getElementById('journal-delete-range-images-btn');
    if (journalDeleteRangeImagesBtn) {
        journalDeleteRangeImagesBtn.addEventListener('click', async () => {
            const start = parseInt(document.getElementById('journal-range-start').value, 10);
            const end   = parseInt(document.getElementById('journal-range-end').value, 10);
            if (isNaN(start) || isNaN(end) || start <= 0 || end < start) {
                showToast('请输入有效的起止范围');
                return;
            }
            const chat = _jChat();
            if (!chat) {
                showToast('未找到当前聊天。');
                return;
            }
            if (!confirm(
                `将永久删除第 ${start}～${end} 条消息范围内的所有内嵌真实图片（如相册识图产生的 data URL / 大图数据）。\n` +
                '不会删除：纯 http(s) 图片链接、仅文字的「发来的照片/视频：…」描述。\n' +
                '去掉图后若没有可读文字，将整行删除（与聊天里多选删除一致）。此操作不可恢复。\n\n确定继续？'
            )) return;

            const r = deleteEmbeddedImagesInChatRange(chat, start, end);
            if (r.error) {
                showToast(r.error);
                return;
            }
            if (r.scannedWithImage === 0) {
                showToast('该范围内没有可删除的内嵌图片');
                return;
            }

            await saveData();
            if (currentChatType === 'private' && typeof recalculateChatStatus === 'function')
                recalculateChatStatus(chat);
            if (typeof renderMessages === 'function' && chat.id === currentChatId)
                renderMessages(false, false);
            if (typeof renderChatList === 'function') renderChatList();

            const info = document.getElementById('journal-range-info');
            if (info) info.textContent = `当前聊天总消息数: ${chat.history.length}`;

            showToast(`已处理 ${r.scannedWithImage} 条含内嵌图的消息：整行删除 ${r.deletedRows} 条，其余 ${r.cleanedRows} 条已去掉图片并保留文字`);
        });
    }

    // ── 列表容器点击：层级导航 + 管理模式选择 ──
    journalListContainer.addEventListener('click', e => {
        const target = e.target;

        if (target.closest('.journal-banner-dismiss')) {
            const b = journalGenerateOutcomeBanner;
            journalGenerateOutcomeBanner = null;
            if (b && b.kind === 'success' && b.successNav &&
                b.chatId === currentChatId && b.chatType === currentChatType) {
                const { jYear: navY, jMonth: navM, day: navD } = b.successNav;
                jYear  = navY;
                jMonth = navM;
                jView  = 'day';
                renderJournalList();
                _openSheet(navD);
                requestAnimationFrame(() => {
                    const le = document.getElementById('journal-entry-list');
                    if (le) le.scrollTop = le.scrollHeight;
                });
            } else {
                renderJournalList();
            }
            return;
        }
        if (target.closest('.journal-banner-retry')) {
            openGenerateJournalModal({ prefill: lastJournalGenerateParams });
            return;
        }

        // 管理模式：切换选中
        if (jManageMode) {
            const card = target.closest('.journal-manage-card');
            if (!card) return;
            const id = card.dataset.id;
            if (jSelectedIds.has(id)) {
                jSelectedIds.delete(id);
                card.classList.remove('selected');
                card.querySelector('.journal-manage-checkbox').textContent = '';
            } else {
                jSelectedIds.add(id);
                card.classList.add('selected');
                card.querySelector('.journal-manage-checkbox').textContent = '✓';
            }
            _updateCount();
            return;
        }

        // 年份标签 → 月份视图
        const yearTab = target.closest('.journal-year-tab');
        if (yearTab) {
            jYear = yearTab.dataset.year;
            jView = 'month';
            jLastOpenedSheetDay = null;
            renderJournalList();
            return;
        }

        // 返回年份
        if (target.closest('[data-action="back-year"]')) {
            jView = 'year';
            jYear = null;
            jLastOpenedSheetDay = null;
            renderJournalList();
            return;
        }

        // 月份便利贴 → 日期视图
        const monthNote = target.closest('.journal-month-note');
        if (monthNote) {
            jMonth = monthNote.dataset.month;
            jView = 'day';
            jLastOpenedSheetDay = null;
            renderJournalList();
            return;
        }

        // 返回月份
        if (target.closest('[data-action="back-month"]')) {
            jView = 'month';
            jMonth = null;
            jLastOpenedSheetDay = null;
            renderJournalList();
            return;
        }

        // 拍立得 → 打开底部抽屉
        const polaroid = target.closest('.journal-day-polaroid');
        if (polaroid) { _openSheet(polaroid.dataset.day); return; }
    });

    // ── 底部抽屉关闭 ──
    if (sheetCloseBtn) sheetCloseBtn.addEventListener('click', _closeSheet);
    if (sheetOverlay)  sheetOverlay.addEventListener('click', _closeSheet);

    // ── 底部抽屉内：条目操作 ──
    if (entryList) {
        entryList.addEventListener('click', async e => {
            const target = e.target;
            const card   = target.closest('.journal-entry-card');
            if (!card) return;

            const id   = card.dataset.id;
            const chat = _jChat();
            if (!chat) return;
            const journal = (chat.memoryJournals || []).find(j => j.id === id);
            if (!journal) return;

            // 删除
            if (target.closest('.delete-journal-btn')) {
                if (!confirm('确定要删除这篇日记吗？')) return;
                chat.memoryJournals = chat.memoryJournals.filter(j => j.id !== id);
                await saveData();
                _closeSheet();
                renderJournalList();
                showToast('日记已删除');
                return;
            }

            // 收藏/取消收藏
            if (target.closest('.favorite-journal-btn')) {
                journal.isFavorited = !journal.isFavorited;
                await saveData();
                const btn = target.closest('.favorite-journal-btn');
                btn.classList.toggle('favorited', journal.isFavorited);
                btn.title = journal.isFavorited ? '取消收藏' : '收藏';
                // 同步更新 tag
                const footer     = card.querySelector('.entry-card-footer');
                const existingTag = footer.querySelector('.entry-card-tag');
                if (journal.isFavorited && !existingTag) {
                    const tag = document.createElement('span');
                    tag.className = 'entry-card-tag';
                    tag.textContent = '已收藏';
                    footer.appendChild(tag);
                } else if (!journal.isFavorited && existingTag) {
                    existingTag.remove();
                }
                showToast(journal.isFavorited ? '已收藏' : '已取消收藏');
                return;
            }

            // 点击卡片主体 → 进入详情
            _closeSheet();
            _openDetail(journal);
        });
    }

    // ── 详情页编辑 ──
    editDetailBtn.addEventListener('click', async () => {
        if (!currentJournalDetailId) return;
        const titleEl   = document.getElementById('journal-detail-title');
        const contentEl = document.getElementById('journal-detail-content');
        const isEditing = titleEl.getAttribute('contenteditable') === 'true';

        if (isEditing) {
            const chat = _jChat();
            if (!chat) return;
            const journal = (chat.memoryJournals || []).find(j => j.id === currentJournalDetailId);
            if (!journal) return;
            journal.title   = titleEl.textContent.trim();
            journal.content = contentEl.textContent.trim();
            await saveData();
            titleEl.removeAttribute('contenteditable');
            contentEl.removeAttribute('contenteditable');
            titleEl.style.border = 'none'; titleEl.style.padding = '';
            titleEl.style.outline = 'none'; titleEl.style.outlineOffset = '';
            contentEl.style.border = 'none'; contentEl.style.padding = '';
            contentEl.style.outline = 'none'; contentEl.style.outlineOffset = '';
            editDetailBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.13,5.12L18.88,8.87M3,17.25V21H6.75L17.81,9.94L14.06,6.19L3,17.25Z"/></svg>`;
            showToast('日记已保存');
            renderJournalList();
        } else {
            titleEl.setAttribute('contenteditable', 'true');
            contentEl.setAttribute('contenteditable', 'true');
            titleEl.style.border = '1px dashed #ccc'; titleEl.style.padding = '5px';
            /* 不用 padding 改正文区，否则会与信笺横线周期错位；用 outline 不占据盒模型 */
            contentEl.style.border = 'none';
            contentEl.style.padding = '';
            contentEl.style.outline = '2px dashed rgba(120, 120, 120, 0.45)';
            contentEl.style.outlineOffset = '2px';
            editDetailBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9,16.17L4.83,12L3.41,13.41L9,19L21,7L19.59,5.59L9,16.17Z"/></svg>`;
            titleEl.focus();
        }
    });

    const journalDetailBackBtn = document.getElementById('journal-detail-back-btn');
    if (journalDetailBackBtn) {
        journalDetailBackBtn.addEventListener('click', () => {
            const day = jDetailFromSheetDay;
            // 须保留 data-target：全局委托会在冒泡阶段 switchScreen(data-target)；若缺少则会 switchScreen(undefined) 导致无任何 .screen.active → 白屏。
            // 在下一轮再打开某日抽屉，避免与全局切屏顺序打架。
            setTimeout(() => {
                renderJournalList();
                if (jView === 'day' && jYear && jMonth && day) {
                    _openSheet(day);
                    requestAnimationFrame(() => {
                        const le = document.getElementById('journal-entry-list');
                        if (le) le.scrollTop = le.scrollHeight;
                    });
                }
            }, 0);
        });
    }
}

// ─── 日记范围：删除内嵌真实图片（data URL / 大块 base64），与「生成日记」分步、独立 ───
const J_IMAGE_STUB_REGEX = /^\[.*?发来了一张图片[：:]\]$/;

function _jIsEmbeddedImageData(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim();
    if (/^data:image\//i.test(s)) return true;
    if (/^https?:\/\//i.test(s)) return false;
    if (s.length < 400) return false;
    const compact = s.replace(/\s/g, '');
    return /^[A-Za-z0-9+/]+=*$/.test(compact);
}

function _jPartIsEmbeddedImage(p) {
    return !!(p && p.type === 'image' && typeof p.data === 'string' && _jIsEmbeddedImageData(p.data));
}

function _jMessageHasEmbeddedImage(msg) {
    if (msg.parts && Array.isArray(msg.parts) && msg.parts.some(_jPartIsEmbeddedImage)) return true;
    if (msg.content && typeof msg.content === 'string' && _jIsEmbeddedImageData(msg.content)) return true;
    return false;
}

/** 去掉识图占位句后，是否还有可读正文（不含纯外链图 URL 文案） */
function _jMeaningfulTextsAfterStrip(msg) {
    const out = [];
    for (const p of msg.parts || []) {
        if (p.type !== 'text' && p.type !== 'html') continue;
        const t = (p.text || '').trim();
        if (!t || J_IMAGE_STUB_REGEX.test(t)) continue;
        out.push(t);
    }
    const c = (msg.content && typeof msg.content === 'string') ? msg.content.trim() : '';
    if (c && !_jIsEmbeddedImageData(c) && !J_IMAGE_STUB_REGEX.test(c)) out.push(c);
    return out;
}

/**
 * 在 1-based 闭区间 [start, end] 内删除内嵌真实图片；纯 http(s) 图链、仅文字的「照片/视频」描述不处理。
 * 去掉图后若无正文则整行删除（与聊天多选删消息一致）。
 * @returns {{ error?: string, deletedRows: number, cleanedRows: number, scannedWithImage: number }}
 */
function deleteEmbeddedImagesInChatRange(chat, start, end) {
    if (!chat || !Array.isArray(chat.history)) return { error: '数据异常' };
    const startIndex = start - 1;
    const endIndex = end;
    if (startIndex < 0 || endIndex > chat.history.length || startIndex >= endIndex)
        return { error: '无效的消息范围。' };

    let deletedRows = 0;
    let cleanedRows = 0;
    let scannedWithImage = 0;

    for (let i = endIndex - 1; i >= startIndex; i--) {
        const msg = chat.history[i];
        if (!_jMessageHasEmbeddedImage(msg)) continue;
        scannedWithImage++;

        const newParts = (msg.parts || []).filter(p => !_jPartIsEmbeddedImage(p));
        if (newParts.length) msg.parts = newParts;
        else delete msg.parts;

        if (msg.content && typeof msg.content === 'string' && _jIsEmbeddedImageData(msg.content))
            msg.content = '';

        const meaningful = _jMeaningfulTextsAfterStrip(msg);
        if (meaningful.length === 0) {
            chat.history.splice(i, 1);
            deletedRows++;
            continue;
        }

        if (msg.parts && msg.parts.some(p => p.type === 'html')) {
            if (!msg.content || _jIsEmbeddedImageData(msg.content)) {
                const tParts = msg.parts.filter(p => p.type === 'text').map(p => p.text).filter(Boolean);
                msg.content = tParts.join('\n') || '[多媒体消息]';
            }
        } else if (msg.parts && msg.parts.length) {
            const t = (msg.parts || [])
                .filter(p => p.type === 'text' || p.type === 'html')
                .map(p => (p.text || '').trim())
                .filter(Boolean)
                .filter(x => !J_IMAGE_STUB_REGEX.test(x));
            msg.content = t.join('\n');
            delete msg.parts;
        } else {
            msg.content = meaningful.join('\n');
        }
        cleanedRows++;
    }

    return { deletedRows, cleanedRows, scannedWithImage };
}

// ─── 生成日记 ───
async function generateJournal(start, end, includeFavorited = false) {
    showToast('正在生成日记，请稍候...');

    const placeholder = document.getElementById('no-journals-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    journalGenerateOutcomeBanner = null;
    isJournalGenerating         = true;
    generatingChatId            = currentChatId;
    renderJournalList();

    try {
        const chat = _jChat();
        if (!chat) throw new Error('未找到当前聊天。');

        const startIndex = start - 1;
        const endIndex   = end;
        if (startIndex < 0 || endIndex > chat.history.length || startIndex >= endIndex)
            throw new Error('无效的消息范围。');

        let msgs = chat.history.slice(startIndex, endIndex);
        msgs = filterHistoryForAI(chat, msgs, true);
        msgs = msgs.filter(m => !m.isThinking);
        msgs.forEach(m => {
            if (m.content && typeof m.content === 'string')
                m.content = m.content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
        });

        let worldBooksContent = '';
        let favPrompt = '';
        let summaryPrompt = '';

        if (includeFavorited) {
            const fav = (chat.memoryJournals || []).filter(j => j.isFavorited)
                .map(j => `标题：${j.title}\n内容：${j.content}`).join('\n\n---\n\n');
            if (fav) favPrompt = `【过往回顾】\n这是你之前已经写下的内容，请参考它们，以确保新内容的连续性，并避免重复记录已经记录过的事件。\n\n${fav}\n\n`;
        }

        const historyText = (() => {
            let lastTime = 0;
            return msgs.map(m => {
                let prefix = '';
                const t = m.timestamp;
                if (lastTime === 0 || t - lastTime > 20 * 60 * 1000 || new Date(t).toDateString() !== new Date(lastTime).toDateString()) {
                    const d = new Date(t);
                    prefix = `\n[系统时间: ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}]\n`;
                }
                lastTime = t;
                return `${prefix}${m.content}`;
            }).join('\n');
        })();

        if (currentChatType === 'group') {
            const gwbs = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id)).filter(Boolean);
            worldBooksContent = gwbs.map(wb => wb.content).join('\n\n');
            summaryPrompt = `你是一个群聊记录总结助手。请以完全客观的第三视角，对以下群聊记录进行精简总结。\n\n`;
            if (favPrompt) summaryPrompt += favPrompt;
            summaryPrompt += `群聊名称: ${chat.name}\n群成员列表: ${chat.members.map(m => `${m.groupNickname}(${m.realName})`).join(', ')}\n\n`;
            if (worldBooksContent) summaryPrompt += `背景设定参考:\n${worldBooksContent}\n\n`;
            summaryPrompt += `总结要求：\n1. **客观中立**：使用第三人称视角，不带个人情感色彩。\n2. **精简准确**：只陈述事实，概括主要话题和事件。\n3. **无升华**：不要进行价值升华或感悟评价。\n\n你的输出必须是一个JSON对象，包含以下两个字段：\n- 'title': 格式为"日期·核心事件"。\n- 'content': 总结正文。\n\nStrictly output in JSON format only. Do not speak outside the JSON object.\n\n聊天记录如下：\n\n---\n${historyText}\n---`;
        } else {
            migrateJournalSettings(chat);
            const cwbs = (chat.worldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id)).filter(Boolean);
            worldBooksContent = cwbs.map(wb => wb.content).join('\n\n');
            const style = chat.journalStyleSettings || { mode: 'default', customWorldBookIds: [] };

            if (style.mode === 'summary') {
                summaryPrompt = `你是一个专业的对话记录总结助手。请根据提供的聊天记录，生成一份精简的摘要总结。\n\n`;
                if (favPrompt) summaryPrompt += favPrompt;
                summaryPrompt += `要求：\n1. **体现时间进程**：正文内容必须按时间顺序组织，并明确指出时间点。请严格按照"x年x月x日，发生了[事件]"的格式进行叙述，确保时间线清晰。\n2. **客观平实**：使用第三人称视角，客观陈述事实。**绝对禁止使用强烈的情绪词汇**，保持冷静、克制的叙述风格。\n3. **抓取重点**：识别对话中的核心事件、重要话题转折、关键决策或信息。忽略无关的闲聊和琐碎细节。\n4. **关键原话摘录（重要）**：\n    - 仅当出现具有**极高情感价值**或**重大剧情价值**的对话时，请**直接引用角色的原话**。\n    - **引用格式**：使用引号包裹原话，例如：${chat.realName}说："我永远不会离开你。"\n    - **严格控制数量**：只摘录最闪光、最不可替代的那几句。\n5. **无升华**：不要进行价值升华、感悟或总结性评价，仅记录发生了什么。\n\n你的输出必须是一个JSON对象，包含以下两个字段：\n- 'title': 格式为"日期范围·核心事件"，例如"1月20日-1月22日·关于旅行计划的讨论"。\n- 'content': 总结正文。\n\nStrictly output in JSON format only. Do not speak outside the JSON object.\n\n聊天记录如下：\n\n---\n${historyText}\n---`;
            } else {
                summaryPrompt = `请根据下方聊天记录，以第一人称写一篇日记。**叙述者就是角色「${chat.remarkName || chat.name}」本人**：要像他自己记录，而不是第三者摘要或客服式总结。语气、用词、对 ${chat.myName} 的称呼、思维方式须贴合下方人设与世界观。\n\n`;
                if (favPrompt) summaryPrompt += favPrompt;
                summaryPrompt += "为了更好地理解角色和背景，请参考以下信息：\n=====\n";
                if (worldBooksContent) summaryPrompt += `世界观设定:\n${worldBooksContent}\n\n`;
                summaryPrompt += `你的角色设定:\n- 角色名: ${chat.realName}\n- 人设: ${chat.persona || "一个友好、乐于助人的伙伴。"}\n\n`;
                summaryPrompt += `我的角色设定（对话中的对方）:\n- 我的称呼: ${chat.myName}\n- 我的人设: ${chat.myPersona || "无特定人设。"}\n\n`;
                summaryPrompt += "=====\n";
                if (style.mode === 'custom') {
                    const custwbs = (style.customWorldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id)).filter(Boolean);
                    const custContent = custwbs.map(wb => wb.content).join('\n\n');
                    if (custContent) summaryPrompt += `\n**特别日记格式/风格要求**：\n请优先严格遵循以下风格指南或格式要求来撰写日记：\n${custContent}\n\n`;
                }
                summaryPrompt += `【写作要求】\n`;
                summaryPrompt += `1. **时间锚点**：title 须为「x年x月x日」或「x年x月x日-x月x日·简短主题」，与正文时间范围一致。content 开头先用一句带**公历绝对日期**的话锚定（例如 xxxx年x月x日，……）；若跨越多天，写到新的日期时必须再点明。**同一天内**若聊天跨了不同时段，请结合消息中的时间线索，用自然口吻点出时段（如早上、中午、下午、傍晚、晚上、深夜、凌晨等）再写发生的事，便于理清先后；**不必**写清「几点到几点」，除非聊天里明确出现了具体时刻且对剧情重要。尽量避免不经日期锚定就单独使用「今天」「昨天」「刚才」「那晚」等相对说法，以免日后与「当下对话」混淆。\n`;
                summaryPrompt += `2. **文风抓人设（核心）**：全文口吻、节奏、冷感或热烈、用词粗鄙或文雅、对 ${chat.myName} 的称呼，必须严格贴合上方人设；人设中的口癖、习惯、世界观用语应自然出现。允许碎碎念、主观感受、联想与评价，像真人日记；禁止写成千篇一律的「标准日记模板腔」。\n`;
                summaryPrompt += `3. **事实底线（不可漏写，但用角色自己的话说）**：聊天里若出现过下列内容，正文中必须交代清楚，不可省略到无迹可寻——双方明确的约定、承诺、决定；重要的具体数字、金额、日期或时间点；关系或剧情上的明显转折；${chat.myName} 明确提出且在本段聊天中得到回应的问题或请求。若聊天中本就没有某类信息，不要编造。\n`;
                summaryPrompt += `4. **篇幅**：不追求缩短；在保持人设口吻的前提下写全应记之事，可分段，气氛与细节可写足，但第3条中的要点不得因铺陈气氛而被挤掉。\n\n`;
                summaryPrompt += `你的输出必须是一个 JSON 对象，仅含两个字段：'title'、'content'（完整日记正文）。Strictly output in JSON format only. Do not speak outside the JSON object.\n\n聊天记录如下：\n\n---\n${historyText}\n---`;
            }
        }

        let { url, key, model } = db.apiSettings;
        if (!url || !key || !model) throw new Error('API设置不完整。');
        if (url.endsWith('/')) url = url.slice(0, -1);

        const requestBody = { model, messages: [{ role: 'user', content: summaryPrompt }], temperature: 0.7, response_format: { type: 'json_object' } };
        const endpoint    = `${url}/v1/chat/completions`;
        const headers     = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

        const rawContent  = await fetchAiResponse(db.apiSettings, requestBody, headers, endpoint);
        let clean = rawContent.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const data = JSON.parse(clean);

        const newJournal = {
            id: `journal_${Date.now()}`,
            range: { start, end },
            title:   data.title   || '无标题日记',
            content: data.content || '内容为空。',
            createdAt: Date.now(),
            chatId: currentChatId,
            chatType: currentChatType,
            isFavorited: false
        };

        if (!chat.memoryJournals) chat.memoryJournals = [];
        chat.memoryJournals.push(newJournal);
        await saveData();
        isJournalGenerating = false;
        generatingChatId    = null;
        const cd = new Date(newJournal.createdAt);
        journalGenerateOutcomeBanner = {
            kind: 'success',
            chatId: currentChatId,
            chatType: currentChatType,
            successNav: {
                jYear: String(cd.getFullYear()),
                jMonth: String(cd.getMonth() + 1),
                day: String(cd.getDate())
            }
        };
        renderJournalList();
        showToast('新日记已生成！');

    } catch (error) {
        isJournalGenerating = false;
        generatingChatId    = null;
        journalGenerateOutcomeBanner = {
            kind: 'error',
            chatId: currentChatId,
            chatType: currentChatType
        };
        renderJournalList();
        showApiError(error);
    } finally {
        isJournalGenerating = false;
        generatingChatId    = null;
    }
}

// ─── 从日记标题开头解析「x年x月x日」或「x年x月x日-x日」（用于机械合并标题） ───
function _parseJournalTitleCalendarSpan(title) {
    if (!title || typeof title !== 'string') return null;
    const m = title.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:-(\d{1,2})日)?/);
    if (!m) return null;
    const y = m[1];
    const mo = parseInt(m[2], 10);
    const d0 = parseInt(m[3], 10);
    const d1 = m[4] != null ? parseInt(m[4], 10) : d0;
    return {
        startStr: `${y}年${mo}月${d0}日`,
        endStr: `${y}年${mo}月${d1}日`
    };
}

/** 从字符串中提取所有「YYYY年M月D日」（须含四位年份），返回首尾 */
function _extractCalendarAnchorsFromString(s) {
    if (!s || typeof s !== 'string') return null;
    const re = /(\d{4})年(\d{1,2})月(\d{1,2})日/g;
    const hits = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        hits.push(`${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`);
    }
    return hits.length ? { first: hits[0], last: hits[hits.length - 1] } : null;
}

/** 用于合并总标题：从一段的标题或正文首行取带年份的日期锚点 */
function _segmentCalendarEndpoints(seg) {
    if (!seg) return null;
    let p = _parseJournalTitleCalendarSpan(seg.title);
    if (p) return { start: p.startStr, end: p.endStr };
    let anchors = _extractCalendarAnchorsFromString(seg.title);
    if (anchors) return { start: anchors.first, end: anchors.last };
    const firstLine = (seg.content || '').split('\n')[0].trim();
    anchors = _extractCalendarAnchorsFromString(firstLine);
    if (anchors) return { start: anchors.first, end: anchors.last };
    return null;
}

function _buildMechanicalMergeTitleFromSegments(segments, mergedStart, mergedEnd) {
    const n = segments.length;
    if (n === 0) return `合并回忆 · 消息#${mergedStart}-#${mergedEnd}（0篇）`;
    const r0 = _segmentCalendarEndpoints(segments[0]);
    const r1 = _segmentCalendarEndpoints(segments[n - 1]);
    if (r0 && r1) {
        const a = r0.start;
        const b = r1.end;
        if (a === b) return `合并回忆 · ${a}（${n}篇）`;
        return `合并回忆 · ${a}–${b}（${n}篇）`;
    }
    return `合并回忆 · 消息#${mergedStart}-#${mergedEnd}（${n}篇）`;
}

const _MERGE_PREAMBLE_RE = /^以下为多篇日记原文按时间顺序合并（共 \d+ 篇），各段保留原标题以便对准时间线：\s*/;

function _isMergeProductTitle(t) {
    return t && String(t).trim().startsWith('合并回忆');
}

function _isMergeProductJournal(j) {
    return j && _isMergeProductTitle(j.title);
}

function _stripMergePreambles(text) {
    let t = (text || '').replace(/\r\n/g, '\n').trim();
    while (_MERGE_PREAMBLE_RE.test(t)) t = t.replace(_MERGE_PREAMBLE_RE, '').trim();
    return t;
}

/** 解析「【标题】\n正文」单段 */
function _parseBracketDiarySection(part) {
    const m = String(part).trim().match(/^【([^】]*)】\s*([\s\S]*)$/);
    if (!m) return null;
    return { secTitle: m[1].trim(), secBody: m[2] };
}

/**
 * 将一篇「合并回忆」正文摊平为若干 { title, content }（递归处理套娃合并）
 */
function _expandMergeBody(fallbackTitle, content) {
    const raw = (content || '').replace(/\r\n/g, '\n');
    const text = _stripMergePreambles(raw);
    if (!text) return [{ title: fallbackTitle || '日记', content: raw.trim() }];

    const parts = text.split(/\n\s*---\s*\n/).map(p => p.trim()).filter(Boolean);
    if (parts.length === 0)
        return [{ title: fallbackTitle || '日记', content: text }];

    const out = [];
    for (const part of parts) {
        const parsed = _parseBracketDiarySection(part);
        if (!parsed) {
            out.push({ title: '片段', content: part });
            continue;
        }
        const { secTitle, secBody } = parsed;
        if (_isMergeProductTitle(secTitle)) {
            out.push(..._expandMergeBody(secTitle, secBody));
        } else {
            out.push({ title: secTitle || '日记', content: secBody.trim() });
        }
    }
    return out.length ? out : [{ title: fallbackTitle || '日记', content: text }];
}

/** 勾选列表 → 摊平后的片段（仅当含合并产物时拆包；否则每篇一条） */
function _collectMechanicalMergeSegments(selected) {
    const hasBundle = selected.some(_isMergeProductJournal);
    if (!hasBundle) {
        return selected.map(j => ({
            title: j.title || '日记',
            content: (j.content || '').trim()
        }));
    }
    const out = [];
    for (const j of selected) {
        if (_isMergeProductJournal(j)) {
            const inner = _expandMergeBody(j.title, j.content);
            if (inner.length) out.push(...inner);
            else out.push({ title: j.title, content: (j.content || '').trim() });
        } else {
            out.push({ title: j.title || '日记', content: (j.content || '').trim() });
        }
    }
    return out;
}

// ─── 合并日记：机械拼接为一篇，不调 API；合并篇收藏，原篇取消收藏 ───
async function mergeJournals(journalIds) {
    const chat = _jChat();
    if (!chat) return;

    const selected = (chat.memoryJournals || [])
        .filter(j => journalIds.includes(j.id))
        .sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0));
    if (selected.length === 0) return;

    const mergedStart = selected[0].range?.start ?? 0;
    const mergedEnd   = selected[selected.length - 1].range?.end ?? mergedStart;

    const segments = _collectMechanicalMergeSegments(selected);
    const n = segments.length;
    const mergeTitle = _buildMechanicalMergeTitleFromSegments(segments, mergedStart, mergedEnd);
    const header = `以下为多篇日记原文按时间顺序合并（共 ${n} 篇），各段保留原标题以便对准时间线：\n\n`;
    const body = segments.map((s, i) => `【${s.title || `第${i + 1}段`}】\n${s.content ?? ''}`).join('\n\n---\n\n');
    const mergeContent = header + body;

    const prevFavoriteState = selected.map(j => ({ j, was: !!j.isFavorited }));
    selected.forEach(j => { j.isFavorited = false; });

    const newJournal = {
        id: `journal_${Date.now()}`,
        range: { start: mergedStart, end: mergedEnd },
        title: mergeTitle,
        content: mergeContent,
        createdAt: Date.now(),
        chatId: currentChatId,
        chatType: currentChatType,
        isFavorited: true,
        isMergedBundle: true,
        mergedSegmentCount: n
    };

    if (!chat.memoryJournals) chat.memoryJournals = [];
    chat.memoryJournals.push(newJournal);

    journalGenerateOutcomeBanner = null;

    try {
        await saveData();
        exitJournalManageMode();
        if (jView === 'day' && jYear && jMonth && jLastOpenedSheetDay) {
            _openSheet(jLastOpenedSheetDay);
            requestAnimationFrame(() => {
                const le = document.getElementById('journal-entry-list');
                if (le) le.scrollTop = le.scrollHeight;
            });
        }
        showToast('已合并为一篇：合并篇已收藏，原篇已取消收藏');
    } catch (error) {
        chat.memoryJournals.pop();
        prevFavoriteState.forEach(({ j, was }) => { j.isFavorited = was; });
        renderJournalList();
        showApiError(error);
    }
}

// ─── 迁移旧风格设置 ───
function migrateJournalSettings(chat) {
    if (!chat.journalStyleSettings) {
        const old    = chat.journalWorldBookIds || [];
        const common = chat.worldBookIds || [];
        const unique = old.filter(id => !common.includes(id));
        let mode = 'default', msg = '';
        if (old.length > 0) {
            if (unique.length === 0) { mode = 'default'; msg = '日记功能升级：已自动关联聊天室背景，您的旧设置已合并到"默认风格"。'; }
            else { mode = 'custom'; msg = `日记功能升级：已自动关联聊天室背景，剩余 ${unique.length} 个特殊设定已保留在"自定义风格"中。`; }
        }
        chat.journalStyleSettings = { mode, customWorldBookIds: unique };
        return msg;
    }
    return null;
}
