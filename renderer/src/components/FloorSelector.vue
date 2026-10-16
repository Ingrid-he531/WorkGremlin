<script setup>
/**
 * FloorSelector —— the vertically stacked "floor" pills on the left.
 * A floor = a monitored product (the list is supplied by the server; not hard-coded here; see
 * server/src/products.js for the definition).
 * Merged floors (two forms of one product combined into one floor) scan **multiple disk sources**;
 * with both forms open at once they appear as multiple sessions inside this one floor rather than
 * multiple floors; when a source **cannot read its sessions**, the server supplies an explanation
 * in sources[].note, and the hover tooltip displays it as-is — so "this source can't be read" is
 * distinguishable from "this floor isn't running" (if a floor wants no note, the server simply
 * doesn't send one).
 * The exception is the hook source: it still participates in session collection (the server relies
 * on it as a fallback to list sessions, see refresh in sessionRegistry), but it has no disk
 * directory of its own, so listing it would only be a bare "no separate disk directory"; hence it
 * is not shown in the tooltip.
 *
 * The status dot reflects **whether this floor has active sessions** (the global active-session
 * table; entries with no event for 60 minutes are evicted):
 *   - Has active sessions: green status dot + count badge
 *   - None (or not installed at all): grey status dot
 * Floors without active sessions can still be clicked into; the office is shown as usual, only the
 * dropdown is empty.
 * Not installed (the backend found no install location or disk data): dimmed overall, showing
 * "not installed".
 * Selected: highlighted border (accent + outer glow).
 *
 * Elevator (design-elevator-transition.md §1 / §5.2): `.rail` is the shaft, and this component
 * additionally mounts a `.car` cabin overlay. Both the highlight and the cabin position come from
 * useElevator (effort §2.3 option A), guaranteeing that a mismatch like "highlight at 4F, cabin at
 * 3F" never occurs.
 * The lintel screen (TaskTicker, scrolling each floor's tasks) is **not here**: it is mounted above
 * the elevator doors (the lintel of ElevatorDoors). The shaft side is responsible only for the
 * shaft + cabin.
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useElevator } from '../composables/useElevator';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps({
  products: { type: Array, default: () => [] },
  modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const { displayFloor, carFloor, phase, moveMs } = useElevator();

function select(p) {
  emit('update:modelValue', p.id);
}

/* ---------- Cabin positioning ---------- */

const railEl = ref(null);
/** Pill DOM (floorId → element): used to measure offsetTop; not reactive — only the measured result goes in */
const floorEls = new Map();
/** { [floorId]: { top, height } } — measured cache; ResizeObserver only writes here */
const metrics = ref({});
let ro = null;

function setFloorEl(id, el) {
  if (!el) {
    floorEls.delete(id);
    return;
  }
  floorEls.set(id, el);
  if (ro) ro.observe(el);
}

function sameMetrics(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] && b[k].top === a[k].top && b[k].height === a[k].height);
}

/**
 * Measure the positions of all pills once.
 * It cannot be computed rigidly by index: pill height varies with path text wrapping
 * (design §5.2 / §8.1).
 * offsetTop is relative to offsetParent — `.rail` is already position: relative, so this is the
 * shaft coordinate.
 */
function measure() {
  const next = {};
  floorEls.forEach((el, id) => {
    next[id] = { top: el.offsetTop, height: el.offsetHeight };
  });
  if (sameMetrics(next, metrics.value)) return; // The 10s poll also comes through here; if the value is unchanged, don't disturb rendering
  metrics.value = next;
}

const carMetric = computed(() => metrics.value[carFloor.value] || null);

/** Cabin: only transform moves (+ static height/opacity); width / left / top are untouched */
const carStyle = computed(() => ({
  height: `${carMetric.value.height}px`,
  transform: `translateY(${carMetric.value.top}px)`,
  // Only the moving phase actually runs in the shaft; 0ms otherwise (stays docked, doesn't slide ahead with the highlight)
  transitionDuration: phase.value === 'moving' ? `${moveMs.value}ms` : '0ms',
}));

/* ---------- The cabin's own floor-number strip ---------- */

/**
 * The original design §1 "floor numbers" version: the **odometer digit strip inside the cabin** —
 * a vertical string of floor numbers; the window reveals only one slot, and the strip scrolls to
 * whichever floor the cabin scrolls to.
 *
 * Division of labor with the lintel screen (the two screens are not duplicates — real elevators
 * have one each too):
 *   · Lintel screen = landing indicator: fixed, answers "which floor are we at / which floor are
 *     we going to" (including direction)
 *   · Here          = the cabin's own display: travels with the car, floor numbers only; passing
 *     intermediate floors you can see the digits scroll by
 *
 * Alignment relies on "the same curve + the same moveMs" (the parallel note in design §2
 * paragraph 2): the strip and the cabin share `--ease-shaft-move` and the inline
 * transitionDuration, so they are naturally in sync —
 * hence the design §7.1 set of "precompute ease⁻¹(k/N) setTimeout per floor count" is no longer
 * needed.
 */
const odoSlots = computed(() => props.products.map((f) => ({ id: f.id, lit: f.installed !== false })));
const odoIndex = computed(() => {
  const i = odoSlots.value.findIndex((s) => s.id === carFloor.value);
  return i < 0 ? 0 : i;
});
const odoStyle = computed(() => ({
  transform: `translateY(calc(-1 * ${odoIndex.value} * var(--car-slot)))`,
  transitionDuration: phase.value === 'moving' ? `${moveMs.value}ms` : '0ms',
}));

/**
 * Align the top of the 1F pill with the top of the office scene on the right: measure the offset
 * of .scene-wrap relative to the top of the shaft and write it into --office-top.
 * That offset = the lintel (its content sets the height, no fixed value) + the stage padding, so it
 * can only be measured, not computed rigidly in CSS.
 */
function syncOfficeTop() {
  const rail = railEl.value;
  const scene = document.querySelector('.scene-wrap');
  if (!rail || !scene) return; // Not the office tab: no .scene-wrap, keep the previous result
  const t = Math.round(scene.getBoundingClientRect().top - rail.getBoundingClientRect().top);
  rail.style.setProperty('--office-top', `${Math.max(0, t)}px`);
}

let lintelRo = null;
let officeTopRaf = 0;

onMounted(() => {
  measure();
  // The callback only writes the cache; it doesn't touch phase or restart the animation (design §5.2)
  ro = new ResizeObserver(() => measure());
  if (railEl.value) ro.observe(railEl.value);
  floorEls.forEach((el) => ro.observe(el));

  // The lintel height changes with the floor screen's content and on window resize → remeasure in
  // all three places (on the first frame the sibling component may not be mounted yet, so wait one frame)
  officeTopRaf = requestAnimationFrame(syncOfficeTop);
  const lintel = document.querySelector('.lintel');
  if (lintel) {
    lintelRo = new ResizeObserver(syncOfficeTop);
    lintelRo.observe(lintel);
  }
  window.addEventListener('resize', syncOfficeTop);
});

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  ro = null;
  if (lintelRo) lintelRo.disconnect();
  lintelRo = null;
  cancelAnimationFrame(officeTopRaf);
  window.removeEventListener('resize', syncOfficeTop);
});

/** The floor list changed (first load / 10s poll) → measure once more after the DOM updates */
watch(() => props.products, () => measure(), { flush: 'post' });

/**
 * Form display name (the sub-item label inside the hover tooltip). plugin uniformly uses the
 * Chinese "plugin" label.
 * dir is the source that "only has disk data and can't read sessions" (both of 5F TraeCode's
 * sources); by default it is called the Chinese "data" label, so it doesn't stack with the outer
 * "Storage:" section header into "Storage: Storage - …".
 * There is no 'hook': that source is filtered out in tip() (it has no disk directory, so listing it
 * carries no information).
 */
/**
 * The form name of one source. 'CLI' / 'IDE' are not localized; 'plugin' / 'dir' go through i18n
 * (the server-sent label may be the English 'plugin', see the replacement in sourceInfo below).
 */
function sourceLabelOf(src) {
  const kind = String((src && src.kind) || '');
  if (kind === 'cli') return 'CLI';
  if (kind === 'plugin') return t('floor.form_plugin');
  if (kind === 'dir') return t('floor.kind_dir');
  return kind || t('floor.kind_dir');
}

/**
 * The install row name for non-plugin forms. Most products' command form is simply CLI; TraeCode is
 * the exception — its non-plugin form is the **desktop IDE itself** (trae / trae-cn, no standalone
 * CLI), so it shows 'IDE'.
 * Same convention as CLIENT_LABELS (trae → TraeCode IDE) in renderer/src/lib/clientMatch.js.
 */
const FORM_LABEL = { trae: 'IDE' };
function cliFormLabel(p) {
  const base = String((p && (p.client || p.dataKind)) || '').toLowerCase();
  return FORM_LABEL[base] || 'CLI';
}

/**
 * Sub-item indentation. **The section header takes its own line and all sub-items share the same
 * prefix** — this guarantees the CLI / plugin rows start at the same position: title tooltips use a
 * proportional font, so if the first item were inlined after the section header
 * (`Installed: CLI - …`) and later lines aligned to it, the indent width would never match the
 * header width; a uniform indent never misaligns under any font / leading-whitespace handling.
 */
const TIP_INDENT = '  ';

/**
 * Normalize one source into { label, detail, note }:
 *   label  form name (CLI / plugin / server-provided label, e.g. IDE)
 *   detail data directory + stats — both `dataPathLabel` and `stats` are supplied
 *          by the server; the renderer only displays them and never reads the
 *          agent's local storage directly.
 *   note   explanation shown when this source has no sessions
 */
function sourceInfo(src) {
  const raw = src.label || sourceLabelOf(src);
  // If the server-sent label contains the English "Plugin", swap it for the localized plugin label
  // — covering 5F TraeCode's 'plugin' and 3F Codex / 7F Kilo's 'CLI/Plugin'.
  const label = raw.replace(/plugin/gi, t('floor.form_plugin'));
  if (!src.dataPathLabel) return { label, detail: t('floor.no_data_dir'), note: src.note || '' };
  const s = src.stats || {};
  const bits = [];
  if (s.sessions) bits.push(t('floor.sessions_files', { n: s.sessions }));
  if (s.files) bits.push(t('floor.n_files', { n: s.files }));
  if (s.sizeLabel) bits.push(s.sizeLabel);
  if (s.lastModifiedAt) bits.push(t('floor.last_write', { time: new Date(s.lastModifiedAt).toLocaleString() }));
  return {
    label,
    detail: `${src.dataPathLabel}${bits.length ? `（${bits.join(' · ')}）` : ''}`,
    note: src.note || '',
  };
}

/**
 * Append a section: the header takes its own line and each sub-item line is uniformly indented
 * (`row = { text, note? }`, note one level deeper).
 * All sub-lines share the same indent prefix — this is the key to "CLI / plugin rows starting at
 * the same position".
 */
function pushSection(lines, title, rows) {
  lines.push(`${title}：`);
  for (const row of rows) {
    lines.push(`${TIP_INDENT}${row.text}`);
    if (row.note) lines.push(`${TIP_INDENT}${TIP_INDENT}· ${row.note}`);
  }
}

/**
 * Hover tooltip: active sessions + "Installed" + "Data" sections, each listing
 * its forms (CLI / plugin) row by row.
 *
 * All values are supplied by the server and rendered as-is — the renderer never
 * reads the agent's local storage directly. The "Installed" paths and the "Data"
 * directory (`dataPathLabel`) together with its `stats` (session/file counts,
 * size, last write) are resolved server-side; the renderer only displays
 * `src.dataPathLabel`, `src.stats` and `src.note`. Shape:
 *   CodeBuddy
 *   Active sessions: 1
 *   Installed:
 *     CLI - <server-reported install path>
 *     Plugin - <server-reported extension dir>
 *   Data:
 *     CLI - <server-reported data dir> (1 session file · …)
 *     Plugin - <server-reported data dir> (…)
 */
function tip(p) {
  const lines = [p.name, t('floor.active_sessions', { n: p.activeCount || 0 })];
  if (!p.installed) {
    lines.push(t('floor.not_installed'));
    return lines.join('\n');
  }

  // Storage sources (the hook source is not listed, see the comment below)
  const sources = (Array.isArray(p.sources) ? p.sources : []).filter((src) => src && src.kind !== 'hook');
  const installPaths = Array.isArray(p.installPaths) ? p.installPaths : [];
  // Whether this floor has a "plugin" form: a plugin route is attached among the sources (kind is
  // plugin, or the label contains Plugin — e.g. 3F/4F/6F/7F's 'CLI/Plugin', 5F's 'plugin'), or the
  // install list already has a plugin entry.
  // A pure-CLI floor (2F WorkBuddy, label only cli) does not force a "not found" row.
  // (p.pluginRe is ignored: it's a RegExp and becomes {} through JSON, so the frontend can't get it.)
  const hasPluginForm =
    sources.some((src) => src.kind === 'plugin' || /plugin/i.test(src.label || '')) ||
    installPaths.some((ip) => ip && ip.kind === 'plugin');

  // ---- Installed: one "CLI - path" / "plugin - path" row per form, explicitly "not found" when missing ----
  // The backend supplies installPaths (new server); the old server lacks this field, so fall back to a single installPathLabel line.
  if (installPaths.length) {
    const cli = installPaths.find((ip) => ip && ip.kind === 'cli');
    const plug = installPaths.find((ip) => ip && ip.kind === 'plugin');
    const missing = t('floor.not_found');
    const rows = [{ text: `${cliFormLabel(p)} - ${(cli && (cli.label || cli.path)) || missing}` }];
    if (hasPluginForm) rows.push({ text: `${t('floor.form_plugin')} - ${(plug && (plug.label || plug.path)) || missing}` });
    pushSection(lines, t('floor.install'), rows);
  } else if (p.installPathLabel) {
    pushSection(lines, t('floor.install'), [{ text: `${cliFormLabel(p)} - ${p.installPathLabel}` }]);
  } else {
    lines.push(t('floor.install_not_found'));
  }

  // ---- Storage: list each route's data directory and stats ----
  // A route whose sessions cannot be read carries an explanatory line (note). The hook route is not
  // listed: it has no separate storage directory (sourceDirs returns an empty array for it), so
  // listing it carries no information.
  // Presentation-layer filter only: the server still sends that hook source, and sessionRegistry's
  // refresh relies on it to decide whether to fall back to the reporter state file for listing
  // sessions (cliLandingSeen); touching it would make 5F / 6F's sessions disappear.
  //
  // The note for 7F Kilo / 8F OpenCode ("this route reads the xxx.db (SQLite) under the data root,
  // not a scannable session file") is not shown in the hover tooltip: those two floors' sessions
  // are polled from a SQLite database by nature — that's a design fact, not a failure note saying
  // "this route can't be read" — so putting it in the tooltip would just repeat the path info the
  // "Storage:" header already gave.
  // (The note field is still sent/passed through: sessionRegistry and the server's self-check use
  // it; here it is only hidden in the render layer.)
  const isPollingDb = (src) => src.kind === 'kilo' || src.kind === 'opencode';
  if (sources.length) {
    pushSection(
      lines,
      t('floor.storage'),
      sources.map((src) => {
        const info = sourceInfo(src);
        return { text: `${info.label} - ${info.detail}`, note: isPollingDb(src) ? '' : info.note };
      })
    );
  } else if (p.dataPathLabel) {
    // Fallback for the old server (no sources field)
    const info = sourceInfo({ kind: '', dataPathLabel: p.dataPathLabel, stats: p.stats });
    pushSection(lines, t('floor.storage'), [{ text: `${t('floor.kind_dir')} - ${info.detail}`, note: info.note }]);
  } else {
    lines.push(t('floor.storage_not_found'));
  }
  return lines.join('\n');
}

/** The agent directory (path) is no longer shown on the pill — the path info is still in the hover tooltip (tip); uninstalled floors only keep the "not installed" status text */
</script>

<template>
  <!-- data-phase is attached here: the cabin door seam line (.car::after)'s "brighten on close + lock on arrival" is driven by it -->
  <aside ref="railEl" class="rail" :data-phase="phase" :aria-label="t('floor.title')">
    <!-- Header: same height as "lintel + stage padding" on the right (--office-top, measured), aligning the top of the 1F pill with the top of the office scene -->
    <div class="rail-head">
      <header class="rail-title">{{ t('floor.title') }}</header>
    </div>

    <!-- Pill area: the content is scaled down 30% overall (the scale affects only this area, the title is not involved) -->
    <div class="rail-floors">
      <button
        v-for="p in products"
        :key="p.id"
        :ref="(el) => setFloorEl(p.id, el)"
        type="button"
        class="floor"
        :class="{ selected: p.id === displayFloor, dim: !p.installed }"
        :disabled="!p.installed"
        :title="tip(p)"
        @click="select(p)"
      >
        <span class="fid">{{ p.id }}</span>
        <span class="fname">{{ p.name }}</span>
        <span class="fstat">
          <span class="fdot" :class="p.activeCount ? 'on' : 'off'" />
          <span v-if="p.activeCount" class="fbadge">{{ p.activeCount }}</span>
        </span>
      </button>

      <!-- Cabin: the cell inside the shaft. Purely decorative (doesn't block clicks, not in the a11y tree); movement only uses transform -->
      <div v-if="carMetric" class="car" :style="carStyle" aria-hidden="true">
        <!-- The floor-number strip inside the cabin: the window reveals only one slot, scrolling through each floor with the car (design §1, the original "floor numbers" version) -->
        <div class="car-odo">
          <div v-if="odoSlots.length" class="car-odo-strip" :style="odoStyle">
            <span v-for="s in odoSlots" :key="s.id" :class="{ dim: !s.lit }">{{ s.id }}</span>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  /* Shaft outer frame: width = pill area layout width 140 × 0.7 (pills scaled down 30% overall, see .rail-floors) */
  flex: 0 0 98px;
  width: 98px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel, #0e1116);
  overflow: hidden;
}

/* Header: height = "lintel + stage padding" on the right (measured at runtime into --office-top,
   see syncOfficeTop), so the top edge of the first pill below (1F) aligns horizontally with the
   top edge of the office scene */
.rail-head {
  flex: none;
  height: var(--office-top, 70px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.rail-title {
  /* The "Floor" title: not part of the pill area's 0.7 scaling, font size increased separately (was 11px) */
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 2px;
  color: var(--muted, #6e7681);
  text-align: center;
}

/* Pill area (= the former shaft): laid out at the original size (width 140), zoom(0.7), pills stay
 * compact.
 * The layout is now "compact stack from the top": no longer fills the whole column, no more
 * space-between spreading the pills far apart.
 *   · flex: 1 1 auto + min-height: 0  → fills the remaining height below the title, but scrolls on
 *     its own when the content overflows (with few floors the bottom panel stays empty; a scrollbar
 *     only appears when there are too many floors to fit).
 *   · justify-content: flex-start + small gap → packed tightly from the top, not spread out.
 * Use zoom, not transform: scale(): scale does not participate in layout, so overflow / scrollbars
 * are still judged by the unscaled height — a visual 70% could still show a scrollbar (with lots of
 * empty space below). zoom truly scales the layout box, so scroll judgment matches the visuals.
 * The cabin and the number strip scale with the subtree; positioning still relies on the measured
 * offsetTop/offsetHeight (the same zoom coordinate system) and never misaligns. */
.rail-floors {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  width: 140px; /* Layout width; after zoom 0.7 the visual width is exactly 98 = the shaft width */
  zoom: 0.7;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 0 10px 14px;
  overflow-y: auto;
  overflow-x: hidden;
}

/* Cabin: slides inside the shaft following carFloor. Only transform is animated; the duration is given inline per floor count */
.car {
  position: absolute;
  top: 0;
  /* Left/right align with the pill content edge (= .rail's 10px left/right padding); top/bottom position and height come from measurement */
  left: 10px;
  right: 10px;
  z-index: 2;
  border-radius: 16px;
  border: 2px solid var(--accent, #58a6ff);
  background: color-mix(in srgb, var(--accent, #58a6ff) 12%, transparent);
  pointer-events: none; /* Purely decorative: must not block pill clicks */
  transition: transform var(--dur-shaft-move) var(--ease-shaft-move);
}

/* The floor-number strip inside the cabin (design §1, the original "floor numbers" version): the
   window spans the cabin and the digits scroll through it slot by slot.
   The window height = one slot (`--car-slot`, exactly the line height of the pill's `.fid`), and
   vertically it sits on the pill's first line (`.floor`'s padding-top 14px), so **at rest it covers
   the pill's own floor-number line entirely**.
   Why it must span the full width (instead of a small square patch): while running the car is
   between two slots, and the floor number "being covered" would peek out from the side — my first
   version used a 44px-wide square, and screenshots showed "small screen 4F" and "pill 4F" ghosting
   side by side. With the strip filled across, every floor number the car covers is inside the
   strip, which reads as "digits scrolling through the window".
   When changing `.floor`'s padding-top or `.fid`'s font size, the top here must change too. */
.car-odo {
  position: absolute;
  top: 14px;
  left: 0;
  right: 0;
  height: var(--car-slot);
  display: flex;
  justify-content: center;
  border-radius: 2px;
  background: var(--lcd-bg, #05070a);
  box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.8);
  overflow: hidden; /* Reveal only one slot: the neighbours above and below are clipped */
  font-family: var(--mono, monospace);
}

/* The duration is given inline (only set while moving); the curve is the same as the cabin's — so the digits and the car are naturally in sync */
.car-odo-strip {
  display: flex;
  flex-direction: column;
  transition: transform var(--dur-shaft-move) var(--ease-shaft-move);
}

.car-odo-strip span {
  height: var(--car-slot);
  line-height: var(--car-slot);
  font-size: 19px; /* Same font size as the pill's .fid — the display strip covers the whole pill floor-number line, so change both together */
  font-weight: 700;
  letter-spacing: 0.5px;
  text-align: center;
  color: var(--lcd-lit, #7fe6ff);
  text-shadow: 0 0 5px currentColor;
}

/* Not-installed floors (greyed out, not clickable): the segments are dimmed — the cabin physically passes it, but that doesn't mean it "can be reached" */
.car-odo-strip span.dim {
  color: var(--lcd-dim, #33414d);
  text-shadow: none;
}

/* will-change is only attached while genuinely scrolling floor numbers and removed immediately on idle (the same rule as the doors / lintel screen) */
.rail[data-phase='moving'] .car-odo-strip {
  will-change: transform;
}

/* While running, dim the floor numbers in the shaft: when the car is between two slots, the white
   digits of the slot it covers peek out from under the display strip (a momentary "ghosting").
   After dimming, the only bright things in the whole shaft are the cabin's scrolling display strip
   + the destination slot — this both removes the ghosting and makes it obvious at a glance that
   "the digits are rolling" and which floor we're heading to. On arrival (opening) it immediately
   returns to normal.
   (The `.selected` slot is not dimmed: it is the destination the user just clicked, and dimming it
   would erase half of the "I'm going to 5F" information.) */
.rail[data-phase='moving'] .floor:not(.selected) .fid {
  opacity: 0.32;
  transition: opacity var(--dur-settle) linear;
}

/* Cabin door seam: the pill is only 140px wide, so real door panels would be illegible — a single vertical line hints at it (design §1) */
.car::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 12%;
  bottom: 12%;
  width: 1px;
  background: var(--accent, #58a6ff);
  opacity: 0.35;
  transition: opacity var(--dur-door-close) linear;
}

/* Closing (design §2 paragraph 1b): the door seam line brightens as the doors close, then "locks"
   once fully shut — a 40ms brightness pulse whose delay starts exactly when closing ends
   (delay = --dur-door-close). Once the animation enters its delay phase it takes over opacity, so
   it doesn't fight the transition above. */
[data-phase='closing'] .car::after {
  opacity: 0.5;
  animation: car-lock 40ms linear var(--dur-door-close) 1;
}

@keyframes car-lock {
  0% {
    opacity: 0.5;
  }
  45% {
    opacity: 1;
  }
  100% {
    opacity: 0.55;
  }
}

.floor {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px 16px;
  border-radius: 16px;
  border: 2px solid var(--border);
  background: var(--surface, #161b22);
  color: var(--text, #e6edf3);
  cursor: pointer;
  font: inherit;
  /* Scope it to .floor only: the cabin (.car) has its own transform transition, and the two must not override each other */
  transition: border-color 0.15s, transform 0.1s, opacity 0.15s, box-shadow 0.15s;
}

.floor:hover {
  border-color: var(--accent, #58a6ff);
}

.floor:active {
  transform: translateY(1px);
}

.floor .fid {
  /* Font size/weight match the cabin display strip (19px / 700, line height still --car-slot 22px) —
     the pill area is scaled down 0.7 overall, so the floor number is enlarged here to compensate;
     when changing the font size, change the display strip (.car-odo-strip) too. */
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.5px;
  line-height: var(--car-slot);
}

.floor .fname {
  font-size: 13px;
  line-height: 1.25;
  text-align: center;
  opacity: 0.9;
}

.floor .fdot {
  width: 8px;
  height: 8px;
  margin-top: 2px;
  border-radius: 50%;
  background: var(--ok, #3fb950);
  box-shadow: 0 0 6px var(--ok, #3fb950);
}

.floor .fdot.off {
  background: var(--muted, #6e7681);
  box-shadow: none;
}

/* Status dot + active session count */
.floor .fstat {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.floor .fbadge {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ok, #3fb950) 22%, transparent);
  color: var(--ok, #3fb950);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

/* Selected: highlighted border + outer glow */
.floor.selected {
  border-color: var(--accent, #58a6ff);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #58a6ff) 28%, transparent);
}

/* Not installed: greyed out + not clickable. Don't push opacity too low (0.72) — the grey is a
   "can't click" hint, and the floor number and name still need to be legible */
.floor.dim {
  color: var(--muted, #6e7681);
  border-color: var(--border);
  opacity: 0.72;
}

.floor.dim:hover {
  border-color: var(--muted, #6e7681);
}

.floor:disabled {
  cursor: not-allowed;
}

.floor:disabled:hover {
  border-color: var(--border);
}
</style>
