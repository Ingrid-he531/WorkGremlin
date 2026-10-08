<script setup>
/**
 * 设置面板：把原来的「中文 / En」语言开关升级成一个「设置」按钮 + 弹出面板。
 * 面板里放：语言切换、版本号（含最近 commit 短 sha）、Electron / Node 运行时版本、
 * GitHub / 反馈外链、以及退出应用。
 * 语言切换即时生效并记住（见 i18n/index.js 的 setLocale），其余行走 Electron 桥接（bridge.js）。
 */
import { ref, computed } from 'vue';
import { useI18n } from '../i18n';
import { getBuildInfo, openExternal, quitApp } from '../api/bridge';

const { locale, setLocale, locales, t } = useI18n();

const open = ref(false);
// 构建信息：版本号 + commit 短 sha + 运行时版本；读取失败前显示占位，读取后替换
const info = ref({ version: '—', commit: '', electron: '', node: '' });
// 外链：项目仓库在 GitHub，反馈走 Issues 页（这两个地址在仓库里是确定的，改这里即可）
const GITHUB_URL = 'https://github.com/Ingrid-he531/WorkGremlin';
const FEEDBACK_URL = 'https://github.com/Ingrid-he531/WorkGremlin/issues';

async function loadInfo() {
  try {
    const b = await getBuildInfo();
    if (b) {
      info.value = {
        version: b.version || '—',
        commit: b.commit || '',
        electron: b.electron || '',
        node: b.node || '',
      };
    }
  } catch {
    /* 读不到就保留占位 */
  }
}

// 应用版本展示格式：0.1.10(xxxxxxxx)，commit 取不到就只显示版本号
const appVersion = computed(() => {
  const v = info.value;
  return v.commit ? `${v.version}(${v.commit})` : v.version;
});

function toggle() {
  open.value = !open.value;
  if (open.value) loadInfo();
}
function close() {
  open.value = false;
}
function onSelectLanguage(e) {
  setLocale(e.target.value);
}
function onLink(url) {
  openExternal(url);
  close();
}
function onQuit() {
  quitApp();
}
</script>

<template>
  <div class="settings">
    <button
      type="button"
      class="set-btn"
      :class="{ on: open }"
      :title="t('nav.settings')"
      data-testid="settings-btn"
      @click.stop="toggle"
    >{{ t('nav.settings') }}</button>

    <template v-if="open">
      <!-- 透明遮罩：点面板以外任意处关闭（按钮自身已 stop 冒泡，不会立即触发关闭） -->
      <div class="pop-mask" @click="close" />
      <div class="pop" role="menu" data-testid="settings-pop">
        <div class="pop-title">{{ t('settings.title') }}</div>

        <div class="row">
          <span class="label">{{ t('settings.language') }}</span>
          <select class="lang-select" :value="locale" @change="onSelectLanguage">
            <option v-for="l in locales" :key="l.key" :value="l.key">{{ l.label }}</option>
          </select>
        </div>

        <div class="sep" />

        <div class="row">
          <span class="label">{{ t('settings.version') }}</span>
          <span class="val">{{ appVersion }}</span>
        </div>
        <div class="row">
          <span class="label">{{ t('settings.electron') }}</span>
          <span class="val">{{ info.electron || '—' }}</span>
        </div>
        <div class="row">
          <span class="label">{{ t('settings.node') }}</span>
          <span class="val">{{ info.node || '—' }}</span>
        </div>

        <div class="sep" />

        <a class="row link" href="#" @click.prevent="onLink(GITHUB_URL)">
          <span class="label">{{ t('settings.github') }}</span>
          <span class="val link-text">github.com/Ingrid-he531/WorkGremlin</span>
        </a>
        <a class="row link" href="#" @click.prevent="onLink(FEEDBACK_URL)">
          <span class="label">{{ t('settings.feedback') }}</span>
          <span class="val link-text">{{ t('settings.feedback') }} / Issue</span>
        </a>

        <div class="sep" />

        <button type="button" class="row quit" @click="onQuit">{{ t('settings.quit') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings { position: relative; flex: none; }
.set-btn {
  padding: 3px 12px;
  font-size: 12px;
  line-height: 1.6;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.set-btn:hover { color: var(--text); }
.set-btn.on { color: var(--accent); background: var(--accent-soft); }

/* 遮罩：铺满视口、透明，专门用来「点外面关闭」；面板 z-index 更高，不会被它挡住 */
.pop-mask { position: fixed; inset: 0; z-index: 900; }
.pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 901;
  width: 272px;
  padding: 8px 0;
  background: var(--bg-elevated, #232a36);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  color: var(--text);
  user-select: none;
}
.pop-title {
  padding: 4px 14px 8px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--text);
  text-decoration: none;
  background: transparent;
  border: 0;
  box-sizing: border-box;
  cursor: default;
}
a.row { cursor: pointer; }
a.row:hover { background: var(--accent-soft); }
.label { color: var(--text-dim); }
.val { color: var(--text); font-variant-numeric: tabular-nums; }
.link-text {
  color: var(--accent);
  max-width: 178px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lang-select {
  background: var(--bg, #1a1f29);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 13px;
  cursor: pointer;
}
.sep { height: 1px; background: var(--border); margin: 6px 0; }
.row.quit {
  text-align: left;
  color: var(--danger, #ff6b6b);
  cursor: pointer;
}
.row.quit:hover { background: rgba(255, 107, 107, 0.12); }
</style>
