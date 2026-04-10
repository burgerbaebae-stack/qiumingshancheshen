// --- 回忆日记功能 (js/modules/journal.js) ---
// 手账本风格 · 年/月/日 三层降维导航
// 数据结构零改动，全部逻辑在 renderJournalList() 中做分组展示

// ─── 模块状态 ───
let generatingChatId = null;

// 层级导航（仅影响显示，不影响数据）
let jView  = 'year';  // 'year' | 'month' | 'day'
let jYear  = null;    // e.g. '2025'
let jMonth = null;    // e.g. '12'

// 管理模式
let jManageMode = false;
let jSelectedIds = new Set();

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
                    ${j.isFavorited ? '<span class="entry-card-tag">🩷 已收藏</span>' : ''}
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

// ─── 打开详情页 ───
function _openDetail(journal) {
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

    // 生成中状态
    let showingLoading = false;
    if (typeof isGenerating !== 'undefined' && isGenerating && generatingChatId === currentChatId) {
        const el = document.createElement('div');
        el.className = 'journal-generating-card';
        el.id = 'journal-generating-card';
        el.innerHTML = `<div class="spinner"></div><div class="text">正在${currentChatType === 'group' ? '总结群聊' : '编织回忆'}...</div>`;
        container.appendChild(el);
        showingLoading = true;
    }

    // 空状态
    if ((!journals || journals.length === 0) && !showingLoading) {
        if (placeholder) placeholder.style.display = 'block';
        return;
    }
    if (placeholder) placeholder.style.display = 'none';

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
    const cancelManageBtn           = document.getElementById('journal-cancel-manage-btn');
    const multiSelectBar            = document.getElementById('journal-multi-select-bar');
    const batchDeleteBtn            = document.getElementById('journal-batch-delete-btn');
    const mergeBtn                  = document.getElementById('journal-merge-btn');
    const selectCountSpan           = document.getElementById('journal-select-count');
    const journalListContainer      = document.getElementById('journal-list-container');
    const entryList                 = document.getElementById('journal-entry-list');
    const sheetCloseBtn             = document.getElementById('journal-entry-sheet-close');
    const sheetOverlay              = document.getElementById('journal-sheet-overlay');

    // ── 管理模式切换 ──
    function _toggleManage(active) {
        jManageMode = active;
        jSelectedIds.clear();
        _updateCount();
        if (active) {
            manageBtn.style.display       = 'none';
            cancelManageBtn.style.display = 'flex';
            multiSelectBar.style.display  = 'flex';
            generateNewJournalBtn.style.display = 'none';
            if (bindWorldBookBtn) bindWorldBookBtn.style.display = 'none';
            _closeSheet();
        } else {
            manageBtn.style.display       = 'flex';
            cancelManageBtn.style.display = 'none';
            multiSelectBar.style.display  = 'none';
            generateNewJournalBtn.style.display = 'flex';
            if (bindWorldBookBtn && currentChatType === 'private') bindWorldBookBtn.style.display = 'flex';
            jView = 'year'; // 退出管理后回年份视图
        }
        renderJournalList();
    }

    function _updateCount() {
        if (selectCountSpan) selectCountSpan.textContent = `已选 ${jSelectedIds.size} 篇`;
    }

    if (manageBtn)       manageBtn.addEventListener('click', () => _toggleManage(true));
    if (cancelManageBtn) cancelManageBtn.addEventListener('click', () => _toggleManage(false));

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

    // ── 合并精简 ──
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
    generateNewJournalBtn.addEventListener('click', () => {
        const chat = _jChat();
        const total = chat ? chat.history.length : 0;
        document.getElementById('journal-range-info').textContent = `当前聊天总消息数: ${total}`;
        const h3 = document.querySelector('#generate-journal-modal h3');
        if (h3) h3.textContent = (currentChatType === 'group') ? '生成群聊总结' : '指定总结范围';
        generateJournalForm.reset();
        generateJournalModal.classList.add('visible');
    });

    generateJournalForm.addEventListener('submit', async e => {
        e.preventDefault();
        const start            = parseInt(document.getElementById('journal-range-start').value);
        const end              = parseInt(document.getElementById('journal-range-end').value);
        const includeFavorited = document.getElementById('journal-include-favorited').checked;
        if (isNaN(start) || isNaN(end) || start <= 0 || end < start) { showToast('请输入有效的起止范围'); return; }
        generateJournalModal.classList.remove('visible');
        await generateJournal(start, end, includeFavorited);
    });

    // ── 列表容器点击：层级导航 + 管理模式选择 ──
    journalListContainer.addEventListener('click', e => {
        const target = e.target;

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
        if (yearTab) { jYear = yearTab.dataset.year; jView = 'month'; renderJournalList(); return; }

        // 返回年份
        if (target.closest('[data-action="back-year"]')) { jView = 'year'; jYear = null; renderJournalList(); return; }

        // 月份便利贴 → 日期视图
        const monthNote = target.closest('.journal-month-note');
        if (monthNote) { jMonth = monthNote.dataset.month; jView = 'day'; renderJournalList(); return; }

        // 返回月份
        if (target.closest('[data-action="back-month"]')) { jView = 'month'; jMonth = null; renderJournalList(); return; }

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
                    tag.textContent = '🩷 已收藏';
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
}

// ─── 生成日记 ───
async function generateJournal(start, end, includeFavorited = false) {
    showToast('正在生成日记，请稍候...');

    const container   = document.getElementById('journal-list-container');
    const placeholder = document.getElementById('no-journals-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    const loadingCard = document.createElement('div');
    loadingCard.className = 'journal-generating-card';
    loadingCard.id = 'journal-generating-card';
    loadingCard.innerHTML = `<div class="spinner"></div><div class="text">正在${currentChatType === 'group' ? '总结群聊' : '编织回忆'}...</div>`;
    if (container.firstChild) container.insertBefore(loadingCard, container.firstChild);
    else container.appendChild(loadingCard);

    isGenerating     = true;
    generatingChatId = currentChatId;

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
                summaryPrompt = `你是一个日记整理助手。请以角色 "${chat.remarkName || chat.name}" 的第一人称视角，总结以下聊天记录。请专注于重要的情绪、事件和细节。\n\n`;
                if (favPrompt) summaryPrompt += favPrompt;
                summaryPrompt += "为了更好地理解角色和背景，请参考以下信息：\n=====\n";
                if (worldBooksContent) summaryPrompt += `世界观设定:\n${worldBooksContent}\n\n`;
                summaryPrompt += `你的角色设定:\n- 角色名: ${chat.realName}\n- 人设: ${chat.persona || "一个友好、乐于助人的伙伴。"}\n\n`;
                summaryPrompt += `我的角色设定:\n- 我的称呼: ${chat.myName}\n- 我的人设: ${chat.myPersona || "无特定人设。"}\n\n`;
                summaryPrompt += "=====\n";
                if (style.mode === 'custom') {
                    const custwbs = (style.customWorldBookIds || []).map(id => db.worldBooks.find(wb => wb.id === id)).filter(Boolean);
                    const custContent = custwbs.map(wb => wb.content).join('\n\n');
                    if (custContent) summaryPrompt += `\n**特别日记格式/风格要求**：\n请优先严格遵循以下风格指南或格式要求来撰写日记：\n${custContent}\n\n`;
                }
                summaryPrompt += `请基于以上所有背景信息，总结以下聊天记录。你的输出必须是一个JSON对象，包含 'title' (年月日·一个简洁的标题) 和 'content' (完整的日记正文) 两个字段，Strictly output in JSON format only. Do not speak outside the JSON object.聊天记录如下：\n\n---\n${historyText}\n---`;
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
        renderJournalList();
        showToast('新日记已生成！');

    } catch (error) {
        const card = document.getElementById('journal-generating-card');
        if (card) card.remove();
        const chat = _jChat();
        if (!chat || !chat.memoryJournals || chat.memoryJournals.length === 0) {
            const ph = document.getElementById('no-journals-placeholder');
            if (ph) ph.style.display = 'block';
        }
        showApiError(error);
    } finally {
        isGenerating     = false;
        generatingChatId = null;
    }
}

// ─── 合并日记 ───
async function mergeJournals(journalIds) {
    const chat = _jChat();
    if (!chat) return;

    const selected = (chat.memoryJournals || [])
        .filter(j => journalIds.includes(j.id))
        .sort((a, b) => a.range.start - b.range.start);
    if (selected.length === 0) return;

    const mergedStart = selected[0].range.start;
    const mergedEnd   = selected[selected.length - 1].range.end;
    const combined    = selected.map(j => `【${j.title}】\n${j.content}`).join('\n\n---\n\n');

    let prompt = `你是一个专业的档案记录员。请将以下多篇日记合并整理成一篇连贯、精简的"回忆录"。\n\n`;
    prompt += `【核心要求】\n1. **体现时间进程**：正文内容必须按时间顺序组织，并明确指出时间点。格式规范：请严格按照"x年x月x日，发生了[事件]"的格式进行叙述，确保时间线清晰。\n`;
    prompt += `2. **客观平实**：使用第三人称视角，客观陈述事实。**绝对禁止使用强烈的情绪词汇**，保持冷静、克制的叙述风格。\n`;
    prompt += `3. **抓取重点**：识别对话中的核心事件、重要话题转折、关键决策或信息。忽略无关的闲聊和琐碎细节。\n`;
    prompt += `4. **关键原话摘录（重要）**：\n    - 仅当出现具有**极高情感价值**（如表白、郑重承诺、极具感染力的情感宣泄）或**重大剧情价值**（如揭示核心秘密、决定性瞬间）的对话时，请**直接引用角色的原话**。\n    - **引用格式**：使用引号包裹原话，例如：${chat.realName}说："我永远不会离开你。"\n    - **严格控制数量**：只摘录最闪光、最不可替代的那几句。如果聊天记录平淡无奇或全是日常琐事，**请不要摘录任何原话**，以免破坏摘要的精简性。\n`;
    prompt += `5. **无升华**：不要进行价值升华、感悟或总结性评价，仅记录发生了什么。\n\n`;
    prompt += `你的输出必须是一个JSON对象，包含以下两个字段：\n- 'title': 一个概括性的标题，例如"1月上旬·关于旅行的筹备与出发"。\n- 'content': 合并后的正文内容。\n\nStrictly output in JSON format only. Do not speak outside the JSON object.\n\n待合并的日记内容如下：\n\n${combined}`;

    showToast('正在合并精简，请稍候...');

    // 退出管理模式
    jManageMode = false;
    jSelectedIds.clear();
    document.getElementById('journal-manage-btn').style.display        = 'flex';
    document.getElementById('journal-cancel-manage-btn').style.display = 'none';
    document.getElementById('journal-multi-select-bar').style.display  = 'none';
    document.getElementById('generate-new-journal-btn').style.display  = 'flex';
    const bwb = document.getElementById('bind-journal-worldbook-btn');
    if (bwb && currentChatType === 'private') bwb.style.display = 'flex';
    jView = 'year';

    // 显示 loading
    const container = document.getElementById('journal-list-container');
    const loadingCard = document.createElement('div');
    loadingCard.className = 'journal-generating-card';
    loadingCard.id = 'journal-generating-card';
    loadingCard.innerHTML = `<div class="spinner"></div><div class="text">正在合并回忆...</div>`;
    container.innerHTML = '';
    container.appendChild(loadingCard);

    isGenerating     = true;
    generatingChatId = currentChatId;

    try {
        let { url, key, model } = db.apiSettings;
        if (!url || !key || !model) throw new Error('API设置不完整。');
        if (url.endsWith('/')) url = url.slice(0, -1);

        const requestBody = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.7, response_format: { type: 'json_object' } };
        const endpoint    = `${url}/v1/chat/completions`;
        const headers     = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };

        const rawContent = await fetchAiResponse(db.apiSettings, requestBody, headers, endpoint);
        let clean = rawContent.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const data = JSON.parse(clean);

        const newJournal = {
            id: `journal_${Date.now()}`,
            range: { start: mergedStart, end: mergedEnd },
            title:   data.title   || '合并日记',
            content: data.content || '内容为空。',
            createdAt: Date.now(),
            chatId: currentChatId,
            chatType: currentChatType,
            isFavorited: false
        };

        if (!chat.memoryJournals) chat.memoryJournals = [];
        chat.memoryJournals.push(newJournal);
        await saveData();
        renderJournalList();
        showToast('日记合并完成！');

    } catch (error) {
        const card = document.getElementById('journal-generating-card');
        if (card) card.remove();
        showApiError(error);
    } finally {
        isGenerating     = false;
        generatingChatId = null;
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
