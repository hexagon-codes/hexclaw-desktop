<script setup lang="ts">
import { useK12Appearance } from './useK12Appearance'

const BUTTERFLY_COUNT = 2
const RIGHT_FIREFLY_COUNT = 14
const SIDEBAR_FIREFLY_COUNT = 4

const { skinActive } = useK12Appearance()

const butterflies = Array.from({ length: BUTTERFLY_COUNT }, (_, index) => index + 1)
const rightFireflies = [
  ['78%', '13%', '0s'],
  ['84%', '23%', '.28s'],
  ['91%', '11%', '.72s'],
  ['96%', '19%', '1.08s'],
  ['80%', '43%', '1.46s'],
  ['90%', '34%', '1.88s'],
  ['96%', '51%', '2.24s'],
  ['78%', '65%', '2.62s'],
  ['87%', '74%', '2.98s'],
  ['96%', '84%', '3.32s'],
  ['76%', '31%', '.48s'],
  ['83%', '54%', '1.27s'],
  ['93%', '66%', '2.05s'],
  ['82%', '88%', '2.78s'],
] as const
const sidebarFireflies = [
  ['1.5%', '68%', '.36s'],
  ['9.5%', '70%', '1.14s'],
  ['2.6%', '83%', '1.96s'],
  ['10%', '85%', '2.64s'],
] as const

if (
  rightFireflies.length !== RIGHT_FIREFLY_COUNT ||
  sidebarFireflies.length !== SIDEBAR_FIREFLY_COUNT
) {
  throw new Error('K12 ambient exact-set mismatch')
}
</script>

<template>
  <div
    v-show="skinActive"
    class="k12-global-presentation"
    data-testid="k12-global-presentation"
    aria-hidden="true"
  >
    <div class="k12-global-presentation__sidebar-scene" />
    <div class="k12-global-presentation__main-scene" />
    <div class="k12-global-presentation__butterflies">
      <span
        v-for="index in butterflies"
        :key="index"
        class="k12-ambient-butterfly"
        :class="`k12-ambient-butterfly--${index === 1 ? 'one' : 'two'}`"
      />
    </div>
    <div class="k12-global-presentation__fireflies">
      <span
        v-for="([x, y, delay], index) in rightFireflies"
        :key="`right-${index}`"
        class="k12-ambient-firefly k12-ambient-firefly--right"
        :style="{ '--x': x, '--y': y, '--delay': delay }"
      />
      <span
        v-for="([x, y, delay], index) in sidebarFireflies"
        :key="`sidebar-${index}`"
        class="k12-ambient-firefly k12-ambient-firefly--sidebar"
        :style="{ '--x': x, '--y': y, '--delay': delay }"
      />
    </div>
  </div>
</template>

<style scoped>
.k12-global-presentation {
  position: fixed;
  inset: var(--hc-titlebar-height) 0 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}

.k12-global-presentation__sidebar-scene,
.k12-global-presentation__main-scene,
.k12-global-presentation__butterflies,
.k12-global-presentation__fireflies {
  position: absolute;
  inset-block: 0;
  background-repeat: no-repeat;
  pointer-events: none;
}

.k12-global-presentation__sidebar-scene {
  left: 0;
  top: auto;
  bottom: 0;
  width: 226px;
  height: 340px;
  background-color: #fbf9ef;
  background-position: -57px bottom;
  background-size: auto 560px;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(0, 0, 0, 0.12) 8%,
    #000 30%,
    #000 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(0, 0, 0, 0.12) 8%,
    #000 30%,
    #000 100%
  );
}

.k12-global-presentation__main-scene {
  left: 226px;
  right: 0;
  background-color: #fffdf6;
  background-position: center right;
  background-size: cover;
}

.k12-global-presentation__butterflies,
.k12-global-presentation__fireflies {
  inset-inline: 0;
}

.k12-global-presentation__fireflies {
  position: fixed;
  inset: 0;
}

.k12-global-presentation__butterflies {
  width: 226px;
}

.k12-ambient-butterfly,
.k12-ambient-firefly {
  position: absolute;
  pointer-events: none;
  user-select: none;
}

.k12-ambient-butterfly {
  opacity: 0;
  background-repeat: no-repeat;
  background-size: 1586px 992px;
  mix-blend-mode: multiply;
  -webkit-mask-image: radial-gradient(
    ellipse at center,
    #000 34%,
    rgba(0, 0, 0, 0.94) 48%,
    transparent 72%
  );
  mask-image: radial-gradient(
    ellipse at center,
    #000 34%,
    rgba(0, 0, 0, 0.94) 48%,
    transparent 72%
  );
  filter: saturate(1.06) drop-shadow(0 3px 4px rgba(118, 89, 29, 0.14));
  transform-origin: top left;
}

.k12-ambient-butterfly--one {
  left: 154px;
  top: 360px;
  width: 72px;
  height: 72px;
  --k12-butterfly-scale: 0.58;
  background-position: -126px -216px;
}

.k12-ambient-butterfly--two {
  left: 130px;
  top: 412px;
  width: 64px;
  height: 64px;
  --k12-butterfly-scale: 0.625;
  background-position: -191px -340px;
}

.k12-ambient-firefly {
  left: var(--x);
  top: var(--y);
  width: 8px;
  height: 8px;
  border-radius: 50%;
  opacity: 0;
  background: radial-gradient(
    circle,
    #fffce2 0 20%,
    #ffe482 32%,
    rgba(255, 218, 101, 0.42) 56%,
    transparent 74%
  );
  box-shadow: 0 0 14px 4px rgba(255, 222, 116, 0.56);
}

:global(
  [data-theme='light'] body[data-k12-skin-active='k12'] .k12-global-presentation__sidebar-scene
) {
  background-image: url('./assets/k12-scene-light.png');
  opacity: 0.98;
}

:global(
  [data-theme='light'] body[data-k12-skin-active='k12'] .k12-global-presentation__main-scene
) {
  background-image: url('./assets/k12-content-light.png');
}

:global([data-theme='light'] body[data-k12-skin-active='k12'] .k12-ambient-butterfly) {
  background-image: url('./assets/k12-scene-light.png');
  transform: scale(var(--k12-butterfly-scale));
}

:global([data-theme='light'] body[data-k12-skin-active='k12'] .k12-ambient-butterfly--one) {
  opacity: 0.82;
}

:global([data-theme='light'] body[data-k12-skin-active='k12'] .k12-ambient-butterfly--two) {
  opacity: 0.78;
}

:global(
  [data-theme='dark'] body[data-k12-skin-active='k12'] .k12-global-presentation__sidebar-scene
) {
  background-color: #071a35;
  background-image: url('./assets/k12-scene-dark.png');
  background-position: -52px bottom;
  background-size: auto 700px;
}

:global([data-theme='dark'] body[data-k12-skin-active='k12'] .k12-global-presentation__main-scene) {
  background-color: #061b3b;
  background-image: url('./assets/k12-content-dark.png');
}

:global([data-theme='dark'] body[data-k12-skin-active='k12'] .k12-ambient-firefly) {
  opacity: 0.72;
}

/* 共享壳只改变材质投影；导航、路由、可访问名称和交互 DOM 保持原样。 */
:global([data-theme='light'] body[data-k12-skin-active='k12']) {
  --hc-bg-sidebar: rgba(250, 249, 241, 0.95);
  --hc-bg-sidebar-solid: #faf9f1;
  --hc-bg-main: #fbfbf5;
  --hc-bg-panel: rgba(255, 254, 249, 0.92);
  --hc-bg-card: rgba(255, 254, 249, 0.94);
  --hc-bg-input: rgba(79, 143, 102, 0.075);
  --hc-bg-hover: rgba(79, 143, 102, 0.075);
  --hc-bg-active: rgba(79, 143, 102, 0.14);
  --hc-bg-elevated: rgba(255, 254, 249, 0.98);
  --hc-bg-gradient: linear-gradient(145deg, #fffdf6 0%, #fbfbf4 54%, #f2f8ed 100%);
  --hc-text-primary: #173d50;
  --hc-text-secondary: #4e6f7d;
  --hc-text-muted: #64808a;
  --hc-border: rgba(103, 133, 90, 0.19);
  --hc-border-subtle: rgba(103, 133, 90, 0.11);
  --hc-divider: rgba(103, 133, 90, 0.13);
  --hc-border-hl: rgba(79, 143, 102, 0.31);
  --hc-accent: #4f8f66;
  --hc-accent-hover: #5c9f73;
  --hc-accent-subtle: rgba(79, 143, 102, 0.14);
  --hc-accent-deep: #39784e;
  --hc-shadow-sm: 0 1px 2px rgba(75, 97, 57, 0.08), 0 2px 6px rgba(75, 97, 57, 0.06);
  --hc-shadow-md: 0 5px 14px rgba(75, 97, 57, 0.1), 0 14px 30px rgba(75, 97, 57, 0.08);
  --hc-shadow-lg: 0 14px 28px rgba(75, 97, 57, 0.12), 0 28px 52px rgba(75, 97, 57, 0.1);
  --hc-scrollbar-thumb: rgba(86, 119, 79, 0.2);
  --hc-scrollbar-thumb-hover: rgba(86, 119, 79, 0.32);
  --hc-scrollbar-thumb-active: rgba(86, 119, 79, 0.44);
}

:global([data-theme='dark'] body[data-k12-skin-active='k12']) {
  --hc-bg-sidebar: rgba(5, 19, 42, 0.93);
  --hc-bg-sidebar-solid: #05132a;
  --hc-bg-main: #071c32;
  --hc-bg-panel: rgba(7, 24, 44, 0.94);
  --hc-bg-card: rgba(15, 40, 67, 0.94);
  --hc-bg-input: rgba(121, 188, 229, 0.105);
  --hc-bg-hover: rgba(121, 188, 229, 0.1);
  --hc-bg-active: rgba(121, 188, 229, 0.16);
  --hc-bg-elevated: rgba(12, 35, 59, 0.98);
  --hc-bg-gradient: linear-gradient(145deg, #06182e 0%, #071d34 52%, #0b2946 100%);
  --hc-text-primary: #f1f6fb;
  --hc-text-secondary: #c5d4e4;
  --hc-text-muted: #a4b8ce;
  --hc-border: rgba(121, 188, 229, 0.17);
  --hc-border-subtle: rgba(121, 188, 229, 0.1);
  --hc-divider: rgba(121, 188, 229, 0.12);
  --hc-border-hl: rgba(121, 188, 229, 0.32);
  --hc-accent: #79bce5;
  --hc-accent-hover: #94ccef;
  --hc-accent-subtle: rgba(121, 188, 229, 0.15);
  --hc-accent-deep: #91c8ec;
  --hc-shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.24), 0 3px 10px rgba(0, 0, 0, 0.2);
  --hc-shadow-md: 0 8px 20px rgba(0, 0, 0, 0.27), 0 18px 38px rgba(0, 0, 0, 0.25);
  --hc-shadow-lg: 0 16px 34px rgba(0, 0, 0, 0.35), 0 30px 60px rgba(0, 0, 0, 0.33);
  --hc-scrollbar-thumb: rgba(170, 207, 233, 0.24);
  --hc-scrollbar-thumb-hover: rgba(170, 207, 233, 0.36);
  --hc-scrollbar-thumb-active: rgba(170, 207, 233, 0.48);
}

:global(body[data-k12-skin-active='k12'] .hc-app) {
  background: var(--hc-bg-main);
  isolation: isolate;
}

:global(body[data-k12-skin-active='k12'] .hc-app__body::after),
:global(body[data-k12-skin-active='k12'] .hc-app__glow) {
  opacity: 0;
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar),
:global(body[data-k12-skin-active='k12'] .hc-app__content),
:global(body[data-k12-skin-active='k12'] .hc-chat),
:global(body[data-k12-skin-active='k12'] .hc-chat__main) {
  background: transparent;
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar) {
  overflow: hidden;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

:global(body[data-k12-skin-active='k12'] .hc-chat__sidebar) {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar__brand),
:global(body[data-k12-skin-active='k12'] .hc-sidebar__nav),
:global(body[data-k12-skin-active='k12'] .hc-sidebar__footer) {
  position: relative;
  z-index: 2;
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar__nav) {
  gap: 6px;
  padding-top: 4px;
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar__group-label),
:global(body[data-k12-skin-active='k12'] .hc-sidebar__divider) {
  display: none;
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar__item) {
  min-height: 40px;
  gap: 11px;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  font-size: 14px;
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar__icon) {
  width: 21px;
  height: 21px;
}

:global(
  [data-theme='light']
    body[data-k12-skin-active='k12']
    .hc-sidebar__item[data-nav-id='chat']
    .hc-sidebar__icon
) {
  color: #4f9a5b;
}

:global(
  [data-theme='light']
    body[data-k12-skin-active='k12']
    .hc-sidebar__item[data-nav-id='agents']
    .hc-sidebar__icon
),
:global(
  [data-theme='light']
    body[data-k12-skin-active='k12']
    .hc-sidebar__item[data-nav-id='knowledge']
    .hc-sidebar__icon
),
:global(
  [data-theme='light']
    body[data-k12-skin-active='k12']
    .hc-sidebar__item[data-nav-id='integration']
    .hc-sidebar__icon
),
:global(
  [data-theme='light']
    body[data-k12-skin-active='k12']
    .hc-sidebar__item[data-nav-id='logs']
    .hc-sidebar__icon
),
:global(
  [data-theme='light']
    body[data-k12-skin-active='k12']
    .hc-sidebar__item[data-nav-id='settings']
    .hc-sidebar__icon
) {
  color: #2d94eb;
}

:global(
  [data-theme='light']
    body[data-k12-skin-active='k12']
    .hc-sidebar__item[data-nav-id='automation']
    .hc-sidebar__icon
) {
  color: #ddb22a;
}

:global([data-theme='light'] body[data-k12-skin-active='k12'] .hc-sidebar__item--active) {
  border-color: rgba(126, 167, 82, 0.3);
  background: linear-gradient(100deg, rgba(233, 246, 212, 0.88), rgba(245, 249, 224, 0.78));
  color: #418c53;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.86);
}

:global([data-theme='dark'] body[data-k12-skin-active='k12'] .hc-sidebar__item) {
  color: #e6edf6;
}

:global([data-theme='dark'] body[data-k12-skin-active='k12'] .hc-sidebar__icon) {
  color: #dce9fb;
  opacity: 1;
}

:global([data-theme='dark'] body[data-k12-skin-active='k12'] .hc-sidebar__item--active) {
  border-color: rgba(230, 208, 136, 0.76);
  background: linear-gradient(100deg, rgba(58, 91, 194, 0.92), rgba(31, 60, 157, 0.96));
  color: #fff4cc;
  box-shadow:
    inset 0 1px 0 rgba(178, 210, 255, 0.22),
    0 5px 12px rgba(0, 0, 0, 0.16);
}

:global(body[data-k12-skin-active='k12'] .hc-sidebar__engine-row) {
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--hc-bg-panel) 94%, transparent);
  box-shadow: 0 5px 18px color-mix(in srgb, var(--hc-text-primary) 7%, transparent);
}

:global([data-theme='light'] body[data-k12-skin-active='k12'] .hc-chat__sidebar) {
  border-right-color: rgba(103, 133, 90, 0.18);
  background: rgba(253, 252, 245, 0.985);
}

:global([data-theme='dark'] body[data-k12-skin-active='k12'] .hc-chat__sidebar) {
  border-right-color: rgba(121, 188, 229, 0.16);
  background: rgba(7, 22, 44, 0.965);
}

:global(body[data-k12-skin-active='k12'] .k12enh-records) {
  inline-size: 100%;
  max-inline-size: none;
}

@media (prefers-reduced-motion: no-preference) {
  :global([data-theme='light'] body[data-k12-skin-active='k12'] .k12-ambient-butterfly--one) {
    animation: k12ButterflyDriftOne 7s linear infinite alternate;
  }

  :global([data-theme='light'] body[data-k12-skin-active='k12'] .k12-ambient-butterfly--two) {
    animation: k12ButterflyDriftTwo 7.6s linear infinite alternate;
  }

  :global([data-theme='dark'] body[data-k12-skin-active='k12'] .k12-ambient-firefly) {
    animation: k12FireflyDrift 3.4s ease-in-out var(--delay) infinite alternate;
  }
}

@keyframes k12ButterflyDriftOne {
  0% {
    transform: translate3d(0, 0, 0) rotate(-1deg) scale(var(--k12-butterfly-scale)) scaleX(1);
    opacity: 0.82;
  }
  18% {
    transform: translate3d(10px, -7px, 0) rotate(2.3deg) scale(var(--k12-butterfly-scale))
      scaleX(0.92);
    opacity: 0.96;
  }
  60% {
    transform: translate3d(14px, -4px, 0) rotate(-1.4deg) scale(var(--k12-butterfly-scale))
      scaleX(1.05);
    opacity: 0.88;
  }
  100% {
    transform: translate3d(4px, -2px, 0) rotate(0.8deg) scale(var(--k12-butterfly-scale))
      scaleX(0.98);
    opacity: 0.84;
  }
}

@keyframes k12ButterflyDriftTwo {
  0% {
    transform: translate3d(0, 0, 0) rotate(0.8deg) scale(var(--k12-butterfly-scale)) scaleX(1);
    opacity: 0.78;
  }
  20% {
    transform: translate3d(-9px, -7px, 0) rotate(-2.5deg) scale(var(--k12-butterfly-scale))
      scaleX(1.08);
    opacity: 0.93;
  }
  62% {
    transform: translate3d(-12px, -4px, 0) rotate(1.5deg) scale(var(--k12-butterfly-scale))
      scaleX(0.93);
    opacity: 0.86;
  }
  100% {
    transform: translate3d(-4px, -2px, 0) rotate(-0.7deg) scale(var(--k12-butterfly-scale))
      scaleX(1.02);
    opacity: 0.8;
  }
}

@keyframes k12FireflyDrift {
  0% {
    transform: translate3d(0, 0, 0) scale(0.92);
    opacity: 0.48;
    box-shadow: 0 0 9px 2px rgba(255, 222, 116, 0.36);
  }
  34% {
    transform: translate3d(4px, -3px, 0) scale(1.56);
    opacity: 1;
    box-shadow: 0 0 20px 6px rgba(255, 222, 116, 0.82);
  }
  68% {
    transform: translate3d(-3px, -1px, 0) scale(1.08);
    opacity: 0.62;
    box-shadow: 0 0 13px 3px rgba(255, 222, 116, 0.54);
  }
  100% {
    transform: translate3d(2px, 2px, 0) scale(1.18);
    opacity: 0.76;
    box-shadow: 0 0 16px 4px rgba(255, 222, 116, 0.66);
  }
}

@media (max-height: 680px) {
  .k12-global-presentation__sidebar-scene {
    height: 270px;
  }

  :global(
    [data-theme='light'] body[data-k12-skin-active='k12'] .k12-global-presentation__sidebar-scene
  ) {
    background-position: -39px bottom;
    background-size: auto 470px;
  }

  :global(
    [data-theme='dark'] body[data-k12-skin-active='k12'] .k12-global-presentation__sidebar-scene
  ) {
    background-position: -33px bottom;
    background-size: auto 550px;
  }
}

@media (max-width: 1040px) {
  .k12-global-presentation__fireflies {
    display: none;
  }
}

@media (max-width: 780px) {
  .k12-global-presentation__sidebar-scene,
  .k12-global-presentation__butterflies {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .k12-ambient-butterfly,
  .k12-ambient-firefly {
    animation: none !important;
  }

  .k12-ambient-butterfly {
    transform: scale(var(--k12-butterfly-scale)) !important;
  }

  .k12-ambient-firefly {
    transform: none !important;
  }
}
</style>
