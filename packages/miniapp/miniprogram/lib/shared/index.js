"use strict";
/** 房间与对局共享协议（M1 房间 + M2 行牌） */
Object.defineProperty(exports, "__esModule", { value: true });
exports.THROW_EMOJI_TONES = exports.THROW_EMOJI = exports.CHAT_TEXT_MAX = exports.MAX_SEATS = void 0;
exports.throwEmojiOf = throwEmojiOf;
exports.MAX_SEATS = 4;
/** 聊天正文长度上限（客户端 `maxlength` 与服务端裁剪**共用这一处数值**） */
exports.CHAT_TEXT_MAX = 60;
/**
 * 定向互动表情表 —— **唯一的扩展点**。
 *
 * 在这里加/删/改一行即可：协议里只传 `id`，图标与中文名由两端各自查这张表，
 * 因此**前端面板、服务端校验、气泡文案会同时跟着变，不需要动任何其它文件**。
 * 注意：**不要改已有条目的 `id`**（会与旧客户端/历史协议对不上），换图标或改名字是安全的。
 */
exports.THROW_EMOJI = [
    // —— 捧场：送点好的 ——
    { id: 'flower', icon: '💐', name: '鲜花', tone: 'good' },
    { id: 'rose', icon: '🌹', name: '玫瑰', tone: 'good' },
    { id: 'beer', icon: '🍺', name: '啤酒', tone: 'good' },
    { id: 'cake', icon: '🍰', name: '蛋糕', tone: 'good' },
    { id: 'thumb', icon: '👍', name: '点赞', tone: 'good' },
    { id: 'clap', icon: '👏', name: '鼓掌', tone: 'good' },
    { id: 'heart', icon: '❤️', name: '比心', tone: 'good' },
    // —— 捣蛋：扔点什么 ——
    { id: 'egg', icon: '🥚', name: '臭鸡蛋', tone: 'bad' },
    { id: 'tomato', icon: '🍅', name: '番茄', tone: 'bad' },
    { id: 'banana', icon: '🍌', name: '香蕉皮', tone: 'bad' },
    { id: 'brick', icon: '🧱', name: '板砖', tone: 'bad' },
    { id: 'mahjong', icon: '🀄', name: '麻将牌', tone: 'bad' },
    { id: 'bomb', icon: '💣', name: '炸弹', tone: 'bad' },
    { id: 'poop', icon: '💩', name: '一坨', tone: 'bad' },
];
/** 面板里各语气组的展示顺序与标题（分组为空则自动跳过） */
exports.THROW_EMOJI_TONES = [
    { tone: 'good', label: '捧场' },
    { tone: 'bad', label: '捣蛋' },
];
/** 按 id 取互动表情；未知 id 返回 null（服务端据此拒绝非法投掷） */
function throwEmojiOf(id) {
    var _a;
    return (_a = exports.THROW_EMOJI.find((e) => e.id === id)) !== null && _a !== void 0 ? _a : null;
}
