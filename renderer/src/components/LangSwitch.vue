<script setup>
/**
 * 界面语言切换（中文 / En）：顶栏里、会话下拉前面。
 * 点了立刻生效并记住（见 i18n/index.js 的 setLocale）——所有走 t() 的文案都会跟着换。
 */
import { useI18n } from '../i18n';

const { locale, setLocale, locales, t } = useI18n();
</script>

<template>
  <div class="lang" role="group" :aria-label="t('nav.lang_title')">
    <button
      v-for="l in locales"
      :key="l.key"
      type="button"
      class="lang-btn"
      :class="{ on: locale === l.key }"
      :title="l.title"
      :aria-pressed="locale === l.key"
      data-testid="lang-switch"
      @click="setLocale(l.key)"
    >{{ l.label }}</button>
  </div>
</template>

<style scoped>
/* 小胶囊：跟顶栏其它控件同一套观感（细边 + 圆角），两个按钮拼一格，选中的那个亮起来 */
.lang {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  flex: none;
}
.lang-btn {
  padding: 3px 9px;
  font-size: 12px;
  line-height: 1.6;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.lang-btn + .lang-btn { border-left: 1px solid var(--border); }
.lang-btn:hover { color: var(--text); }
.lang-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}
</style>
