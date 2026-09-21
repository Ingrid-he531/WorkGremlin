<script setup>
/**
 * ElevatorDoors —— 门楣（电梯门上方那块楼层显示器）+ 主舞台的两扇门。
 *
 * 设计依据：design-elevator-transition.md §1（门做在主舞台而不是轿厢上）/ §7.2、
 *          design-elevator-effort.md §2.4（门楣液晶屏）。
 *
 * 结构（一列两层，像真电梯的门套）：
 *   .elevator-doors
 *     ├─ .lintel  ← 门楣：**不参与动画**的墙带，楼层屏固定在这里（真实电梯的层站指示器位置）
 *     └─ .portal  ← 门洞：主舞台内容 + 两扇门扇，门只在这个区域内开合
 *
 * 要点：
 *   - 门是**装饰层**：`pointer-events: none` + `aria-hidden`，关门瞬间也不许吞点击；
 *   - 门扇只盖住 .portal，所以关门/滑行时不会压住门楣上的屏（屏在门上方，看得见）；
 *   - 位移只动 `transform`（`translateX(±100%)` ↔ 0），不碰 width / left / top；
 *   - 状态完全由 `data-phase` 属性驱动（不用 `<Transition>`、不上 WAAPI —— 设计已否决）；
 *   - `will-change` 只在非 idle 时挂，进 idle 立刻摘（常驻会长期占着合成层显存）；
 *   - 到层响一声"叮"：phase 进 `opening`（门开始开）那一刻触发，见 elevatorChime.js。
 */
import { watch } from 'vue';
import FloorLcd from './FloorLcd.vue';
import { playArrivalChime } from '../lib/elevatorChime';

const props = defineProps({
  /** idle | closing | moving | opening | settling —— 来自 useElevator 的 phase */
  phase: { type: String, default: 'idle' },
  /** 楼层表（门楣上的屏要用它排数字带）：与井道 / 轿厢同一份来源 */
  floors: { type: Array, default: () => [] },
  /** 降级档（系统「减弱动态效果」）的淡出/淡入开关，来自 useElevator 的 flash */
  flash: { type: Boolean, default: false },
});

watch(
  () => props.phase,
  (p, prev) => {
    // 到站：门开始开的那一刻"叮"。只在**进入** opening 时响一次（settling / idle 不重复响）
    if (p === 'opening' && prev !== 'opening') playArrivalChime();
  }
);
</script>

<template>
  <div class="elevator-doors" :data-phase="phase" :data-flash="flash ? 'on' : 'off'">
    <!-- 门楣：墙带 + 固定的楼层显示屏。门扇在下面的 .portal 里滑，够不到这里 -->
    <div class="lintel">
      <FloorLcd :floors="floors" />
    </div>
    <div class="portal">
      <!-- 内容外面再包一层：这是"内容就位"动效的作用对象（直接给 slot 内容的根元素写样式会落到子组件上） -->
      <div class="stage-wrap">
        <slot />
      </div>
      <div class="door door-l" aria-hidden="true" />
      <div class="door door-r" aria-hidden="true" />
    </div>
  </div>
</template>

<style scoped>
.elevator-doors {
  /* 顶替原来 .stage 在 .body 里的角色：撑满主区；门是绝对定位的，所以自己要 relative */
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column; /* 上：门楣（屏）／下：门洞（舞台 + 门扇） */
  overflow: hidden;
}

/* 门楣：屏固定在这里。高度由内容（屏）撑，不写死 —— 改屏的字号不用回来改这里。
 *
 * 外观：和下面的办公室画布**同色、同框、同圆角**（--iso-bg / --border / --radius），
 * 外围再留出一圈（margin 12px，与 .stage 的 padding 对齐，所以门楣和画布的左右边是一条竖线）。
 * 也就是说它**不是**"贴着窗口顶边的一条色带"，而是和画布并排的同一块板 ——
 * 底色跟画布一样，屏才像装在那块板上，而不是浮在一条异色横条里。 */
.lintel {
  flex: none;
  display: flex;
  justify-content: center;
  align-items: center;
  margin: 12px 12px 0;
  padding: 8px 12px;
  background: var(--iso-bg, #151a22);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* 门洞：舞台内容与门扇的容器，门扇滑到 ±100% 时不撑出横向滚动条 */
.portal {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* 内容就位（设计 §2 段 4）：换脸发生在关门 70% 处，所以"新内容"在 moving 段就已经在里面了 ——
   先把整块内容藏起来（moving 全程门是关的，藏了也看不见），门一开始开就 120ms
   opacity/scale 归位。藏的是内容、不是整个舞台：门开的时候不能让人看见一块空白板。
   注意这里没用 [data-phase='closing'] 藏 —— 关门第一帧门还全开着，那一瞬间内容会闪没。 */
.stage-wrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  opacity: 1;
  transform: scale(1);
  transition: opacity var(--dur-settle) var(--ease-settle), transform var(--dur-settle) var(--ease-settle);
}

[data-phase='moving'] .stage-wrap {
  opacity: 0;
  transform: scale(0.985);
  transition: none; /* 这一段全程被门盖着，不需要过渡（等门开时再滑回来） */
}

/* 降级档（系统「减弱动态效果」）：不演电梯，但也不硬切 —— 40ms 淡出、换脸、40ms 淡入。
   时长走 --dur-flash，与 useElevator 的 FLASH_MS 一一对应。 */
[data-flash='on'] .stage-wrap {
  opacity: 0;
  transition-duration: var(--dur-flash);
  transition-timing-function: linear;
}

.door {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 50%;
  z-index: 5;
  background: var(--bg-panel, #1b2029);
  pointer-events: none; /* 纯装饰：关门瞬间也不许吞点击 */
  transition: transform var(--dur-door-open) var(--ease-door-open);
}

/* 门缝：两扇门合拢处留一条线，door-r 的缝在它自己左边 */
.door-l {
  transform: translateX(-100%);
  border-right: 1px solid var(--border-strong, #333b4a);
}

.door-r {
  left: 50%;
  transform: translateX(100%);
  border-left: 1px solid var(--border-strong, #333b4a);
}

/* idle：门开到底。写死在 idle 态，避免首帧闪一下全屏门（effort §2-2 踩坑点 ④） */
[data-phase='idle'] .door-l {
  transform: translateX(-100%);
}

[data-phase='idle'] .door-r {
  transform: translateX(100%);
}

/* closing：合拢。曲线先加速后贴合、尾段不过冲（门撞门不好看） */
[data-phase='closing'] .door {
  transform: translateX(0);
  transition-duration: var(--dur-door-close);
  transition-timing-function: var(--ease-door-close);
}

/* moving：保持闭合。目标值没变 → 不会重新起 transition，只是把上面那条规则接住 */
[data-phase='moving'] .door {
  transform: translateX(0);
}

/* opening / settling 走 .door 的默认态（translateX(±100%) + 开门时长/曲线） */

/* will-change 只在动画期间挂，进 idle 立刻摘 —— 由 phase 驱动，不用 transitionend（会丢事件） */
.elevator-doors:not([data-phase='idle']) .door {
  will-change: transform;
}
</style>
