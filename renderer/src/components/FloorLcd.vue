<script setup>
/**
 * FloorLcd —— **电梯门上方门楣上的楼层显示屏**（段码手感：暗底 + 等宽字 + 发光 + 静态扫描线）。
 *
 * 设计依据：design-elevator-effort.md §2.4（位置 / phase→显示映射表 / token 清单）。
 *
 * 位置：挂在 `ElevatorDoors` 的 `.lintel`（门楣）里，**在电梯门上方、居中**。
 * 这是按"像真实电梯"定下来的：真电梯里那块的正是**层站指示灯 / 楼层数码屏**，
 * 装在门套上、门一开一合它都在，回答"现在在哪层、要去哪层"。
 * 门扇只在 `.portal`（门洞）里滑，够不到门楣，所以关门/运行时屏不会被挡住。
 *
 * 两个仍然是硬道理的设计点（换成门楣位置后依然成立）：
 *   1. 屏**固定不动**、不跟着轿厢在井道里滑：屏自己要是也在动，就是"一个屏里叠两层动画"
 *      （轿厢位移 + 数字滚动），观感是抖而不是快；
 *   2. 轿厢那格只有 140px 宽，塞不下「当前层 + 目的层 + 方向」三样 —— 放门楣上宽度才够。
 *
 * 三条硬约束的落法：
 *   1. 唯一真相源：phase / carFloor / pendingFloor / direction / moveMs 全来自 useElevator，
 *      本组件**不存状态、不自己算楼层** —— 只做 floor id → 槽位下标（给滚动位移用）；
 *   2. 只动 transform / opacity：数字滚动是 transform: translateY，点亮/熄灭是 opacity，
 *      槽位高由 CSS 变量 --lcd-slot 给，不动 width / height / top；
 *   3. 时长走 token：滚动用 --ease-shaft-move + 内联 moveMs（与轿厢**同值同曲线**，
 *      因此数字和轿厢天然对齐，不需要另开定时器/rAF 去"对表"），点亮用 --dur-lcd-fade。
 */
import { computed } from 'vue';
import { useElevator } from '../composables/useElevator';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  /** 井道里的楼层，顺序就是井道顺序（= FloorSelector 的 products，与轿厢、高亮同一份来源） */
  floors: { type: Array, default: () => [] },
});

const { phase, carFloor, pendingFloor, direction, moveMs } = useElevator();

/** 滚动条里的槽位：id 即显示内容；未安装（置灰不可达）的层在屏上压低亮度，不亮段码 */
const slots = computed(() =>
  props.floors.map((f) => ({ id: f.id, lit: f.installed !== false }))
);

/** 轿厢位置对应的槽位下标。层表还没来（carFloor 为空）时夹到 0，屏幕显示 -- */
const slotIndex = computed(() => {
  const i = slots.value.findIndex((s) => s.id === carFloor.value);
  return i < 0 ? 0 : i;
});

/**
 * 滚动位移：translateY(-下标 × 一位高)。一位高就是 --lcd-slot，写在 calc 里，
 * JS 不重复一份 px。duration 只在 moving 段给 moveMs —— 与轿厢内联的 transition-duration 同值，
 * 于是「数字逐层跳过去」和「轿厢滑过去」是同一个时钟、同一条曲线。
 */
const stripStyle = computed(() => ({
  transform: `translateY(calc(-1 * ${slotIndex.value} * var(--lcd-slot)))`,
  transitionDuration: phase.value === 'moving' ? `${moveMs.value}ms` : '0ms',
}));

/** 方向箭头：idle 时退成一个暗点（不表态，避免"停着却指着上"） */
const arrow = computed(() => (direction.value === 'up' ? '▲' : direction.value === 'down' ? '▼' : '•'));

/**
 * 读屏播报：屏上的段码（整条数字带）对 AT 是噪音，这里给一句人话。
 * 文案只在段切换时变一次（数字滚动是 transform，DOM 文本没变），不会刷屏。
 */
const statusText = computed(() => {
  if (pendingFloor.value) {
    return phase.value === 'moving'
      ? t('lcd.to_floor', { floor: pendingFloor.value })
      : t('lcd.from_to', { from: carFloor.value, to: pendingFloor.value });
  }
  if (!carFloor.value) return t('lcd.not_ready');
  return t('lcd.current', { floor: carFloor.value });
});
</script>

<template>
  <div class="lcd" :data-phase="phase">
    <div class="screen" aria-hidden="true">
      <!-- 轿厢位置：整条数字带按 --lcd-slot 逐格滚动，窗口只露一格（odometer） -->
      <div class="pos">
        <div v-if="slots.length" class="lcd-odo" :style="stripStyle">
          <span v-for="s in slots" :key="s.id" :class="{ dim: !s.lit }">{{ s.id }}</span>
        </div>
        <span v-else class="blank">--</span>
      </div>
      <span class="arrow" :class="direction || 'idle'">{{ arrow }}</span>
      <!-- 目的层：还没到站才点亮；到站熄灭，大数字定格在目的层 -->
      <span class="dest" :class="{ on: pendingFloor }">{{ pendingFloor || '--' }}</span>
      <span class="scan" />
    </div>
    <p class="sr" role="status" aria-live="polite">{{ statusText }}</p>
  </div>
</template>

<style scoped>
/* 根容器：门楣（.lintel）里的一个居中项。位置与背景归门楣管，这里只管不参与压缩 */
.lcd {
  flex: none;
}

.screen {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  /* 门楣上宽度够：给一个"牌"的宽度，别让它随窗口拉成一条横条（真电梯那块屏也是定宽的） */
  width: min(320px, 46vw);
  height: calc(var(--lcd-slot) + 16px);
  padding: 0 10px;
  border: 1px solid var(--border-strong, #333b4a);
  border-radius: var(--radius, 10px);
  background: var(--lcd-bg, #05070a);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.75);
  overflow: hidden;
  font-family: var(--mono, monospace);
}

/* 扫描线：静态背景（不参与动画，只画一次），手感来自"有栅格"而不是"在闪" */
.scan {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.035) 0 1px,
    rgba(0, 0, 0, 0) 1px 3px
  );
}

/* 一位数字的窗口：只露一格，上下邻居被裁掉 */
.pos {
  position: relative;
  height: var(--lcd-slot);
  overflow: hidden;
}

.lcd-odo {
  display: flex;
  flex-direction: column;
  /* 时长由内联给（moving 才有值，其余段 0ms）；曲线与轿厢同一条 */
  transition: transform var(--dur-shaft-move, 300ms) var(--ease-shaft-move);
}

.lcd-odo span {
  height: var(--lcd-slot);
  line-height: var(--lcd-slot);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-align: center;
  color: var(--lcd-lit, #7fe6ff);
  text-shadow: 0 0 6px currentColor;
}

/* 未安装（置灰、点不动）：段码压暗，不参与发光 —— 看得见是楼，但不表示"能到" */
.lcd-odo span.dim {
  color: var(--lcd-dim, #33414d);
  text-shadow: none;
}

.blank {
  display: block;
  height: var(--lcd-slot);
  line-height: var(--lcd-slot);
  color: var(--lcd-dim, #33414d);
  font-size: 16px;
}

.arrow {
  font-size: 12px;
  color: var(--lcd-lit, #7fe6ff);
  transition: opacity var(--dur-lcd-fade, 140ms) var(--ease-lcd-fade);
}

.arrow.idle {
  opacity: 0.25;
  color: var(--lcd-dim, #33414d);
}

.dest {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--lcd-lit, #7fe6ff);
  opacity: 0.22; /* 没有目的层时留个"暗段"位，不是消失（段码屏没点亮的段也看得见） */
  transition: opacity var(--dur-lcd-fade, 140ms) var(--ease-lcd-fade);
}

.dest.on {
  opacity: 1;
  text-shadow: 0 0 6px currentColor;
}

/* will-change 只在真的滚数字时挂，进 idle 立刻摘（与门/轿厢同一条规矩） */
.lcd[data-phase='moving'] .lcd-odo {
  will-change: transform;
}

/* 屏上段码不进无障碍树（见模板 aria-hidden），这一句是给 AT 的替代文本 */
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
</style>
