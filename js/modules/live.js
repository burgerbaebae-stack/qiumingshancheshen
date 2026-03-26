// 直播间模块 (js/modules/live.js)

const LiveModule = {
    isLive: false,
    simulationTimer: null,
    danmakuTimer: null,
    
    // 模拟数据库
    mockActions: [
        "（轻轻调整了一下麦克风的位置，眼神温柔地看向镜头）",
        "（拿起手边的水杯抿了一口，嘴角微微上扬）",
        "（似乎看到了什么有趣的弹幕，忍不住笑出声来）",
        "（托着下巴，若有所思地看着屏幕）",
        "（向后靠在椅背上，伸了个懒腰）",
        "（凑近镜头，眯着眼睛仔细辨认屏幕上的字）",
        "（轻轻撩了一下头发，动作显得格外慵懒）",
        "（对着镜头比了一个心，眼神亮晶晶的）"
    ],
    
    mockSpeeches: [
        "大家晚上好呀，今天过得怎么样？",
        "谢谢大家的礼物，破费啦~",
        "这个问题很有意思，让我想想怎么回答...",
        "哈哈，你们太逗了！",
        "今天的BGM好听吗？是我特意挑的。",
        "不要刷屏哦，我都看不过来啦。",
        "欢迎新进直播间的朋友，点点关注不迷路~"
    ],
    
    mockDanmaku: [
        { name: "路人甲", content: "前排围观！" },
        { name: "小猫咪", content: "主播今天好美！" },
        { name: "熬夜冠军", content: "这是什么神仙颜值" },
        { name: "打工人", content: "BGM求歌名" },
        { name: "KKT", content: "666666" },
        { name: "User123", content: "晚上好~" },
        { name: "吃瓜群众", content: "哈哈哈哈哈哈" },
        { name: "富婆", content: "爱了爱了" }
    ],

    init: function() {
        // 绑定关闭按钮
        document.getElementById('live-close-btn')?.addEventListener('click', () => {
            this.exitLiveRoom();
        });

        // 绑定礼物按钮
        document.getElementById('live-gift-btn')?.addEventListener('click', () => {
            this.showGiftEffect("跑车"); // 模拟送礼
        });

        // 绑定发送按钮
        document.getElementById('live-send-btn')?.addEventListener('click', () => {
            const input = document.getElementById('live-input');
            if (input && input.value.trim()) {
                this.addDanmaku("我", input.value);
                input.value = '';
            }
        });
    },

    enterLiveRoom: function(charName = "未知角色", avatarUrl = "") {
        this.isLive = true;
        const screen = document.getElementById('live-room-screen');
        if (!screen) return;

        // 设置主播信息
        document.getElementById('live-host-name').textContent = charName;
        document.getElementById('live-host-avatar').src = avatarUrl || 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg';
        
        // 设置背景 (模拟)
        const bgLayer = document.getElementById('live-bg-layer');
        if (bgLayer) {
            // 这里暂时用固定图，实际可读取角色背景
            bgLayer.style.backgroundImage = `url('${avatarUrl || 'https://i.postimg.cc/Y96LPskq/o-o-2.jpg'}')`;
        }

        // 切换屏幕
        switchScreen('live-room-screen');
        
        // 开始模拟
        this.startSimulation();
    },

    exitLiveRoom: function() {
        this.isLive = false;
        this.stopSimulation();
        switchScreen('home-screen'); // 返回主页
    },

    startSimulation: function() {
        // 立即执行一次
        this.playNextScene();

        // 循环播放动作和语音
        this.simulationTimer = setInterval(() => {
            this.playNextScene();
        }, 8000); // 每8秒切换一次场景

        // 循环播放弹幕
        this.danmakuTimer = setInterval(() => {
            const randomDanmaku = this.mockDanmaku[Math.floor(Math.random() * this.mockDanmaku.length)];
            this.addDanmaku(randomDanmaku.name, randomDanmaku.content);
        }, 1500); // 每1.5秒一条弹幕
    },

    stopSimulation: function() {
        clearInterval(this.simulationTimer);
        clearInterval(this.danmakuTimer);
        // 清空舞台
        const actionText = document.getElementById('live-action-text');
        const speechBubble = document.getElementById('live-speech-bubble');
        if (actionText) {
            actionText.classList.remove('show');
            actionText.textContent = '';
        }
        if (speechBubble) {
            speechBubble.classList.remove('show');
            speechBubble.textContent = '';
        }
        // 清空弹幕
        const danmakuArea = document.getElementById('live-danmaku-area');
        if (danmakuArea) danmakuArea.innerHTML = '';
    },

    playNextScene: function() {
        const actionText = document.getElementById('live-action-text');
        const speechBubble = document.getElementById('live-speech-bubble');
        
        // 1. 淡出旧内容
        if (actionText) actionText.classList.remove('show');
        if (speechBubble) speechBubble.classList.remove('show');

        setTimeout(() => {
            // 2. 更新内容
            const randomAction = this.mockActions[Math.floor(Math.random() * this.mockActions.length)];
            const randomSpeech = this.mockSpeeches[Math.floor(Math.random() * this.mockSpeeches.length)];
            
            if (actionText) actionText.textContent = randomAction;
            if (speechBubble) speechBubble.textContent = randomSpeech;

            // 3. 淡入新内容
            if (actionText) actionText.classList.add('show');
            // 语音稍微延迟一点出现，更有节奏感
            setTimeout(() => {
                if (speechBubble) speechBubble.classList.add('show');
            }, 500);

        }, 1000); // 等待淡出动画完成
    },

    addDanmaku: function(name, content) {
        const area = document.getElementById('live-danmaku-area');
        if (!area) return;

        const item = document.createElement('div');
        item.className = 'live-danmaku-item';
        item.innerHTML = `
            <span class="live-danmaku-name">${name}:</span>
            <span class="live-danmaku-content">${content}</span>
        `;
        
        area.appendChild(item);

        // 自动滚动到底部
        area.scrollTop = area.scrollHeight;

        // 限制弹幕数量，防止卡顿
        if (area.children.length > 20) {
            area.removeChild(area.firstChild);
        }
    },

    showGiftEffect: function(giftName) {
        const container = document.getElementById('live-gift-effect-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = 'live-gift-toast';
        toast.innerHTML = `🚀 感谢老板送出的 ${giftName}！`;
        
        container.appendChild(toast);

        // 动画结束后移除
        setTimeout(() => {
            toast.remove();
        }, 3000);
        
        // 触发主播感谢 (模拟)
        setTimeout(() => {
            const speechBubble = document.getElementById('live-speech-bubble');
            if (speechBubble) {
                speechBubble.textContent = `哇！谢谢送的${giftName}！爱你哟~`;
                speechBubble.classList.add('show');
            }
        }, 500);
    }
};

// 暴露给全局
window.LiveModule = LiveModule;

// 自动初始化
document.addEventListener('DOMContentLoaded', () => {
    LiveModule.init();
    
    // 绑定临时入口按钮 (位于主屏幕)
    document.getElementById('temp-live-entry-btn')?.addEventListener('click', () => {
        LiveModule.enterLiveRoom("测试主播", "https://i.postimg.cc/Y96LPskq/o-o-2.jpg");
    });
});
